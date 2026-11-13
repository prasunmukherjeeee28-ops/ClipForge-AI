from __future__ import annotations

import asyncio
import json
import re
import uuid
from pathlib import Path
from typing import Awaitable, TypeVar

from .client import ProcessorClient
from .config import Settings
from .media import MediaProcessingError, extract_audio, probe_media
from .source_adapters import SourceInspectionError, inspect_video_url
from .transcription_runner import run_transcription_process
from .moments_runner import run_moment_process
from .render import ClipRenderError, render_clip

T = TypeVar("T")


class JobCancelled(Exception):
    pass


class LeaseLost(Exception):
    pass


async def _heartbeat_loop(
    client: ProcessorClient,
    job_id: str,
    lease_id: str,
    lease_token: str,
    stop: asyncio.Event,
    cancelled: asyncio.Event,
    lease_lost: asyncio.Event,
) -> None:
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=25)
            return
        except asyncio.TimeoutError:
            pass
        try:
            result = await client.heartbeat(job_id, lease_id, lease_token)
        except Exception:
            lease_lost.set()
            return
        if result.get("cancelRequested") is True:
            cancelled.set()
            return


async def _with_lease(
    operation: Awaitable[T],
    cancelled: asyncio.Event,
    lease_lost: asyncio.Event,
) -> T:
    task = asyncio.ensure_future(operation)
    cancel_wait = asyncio.create_task(cancelled.wait())
    lost_wait = asyncio.create_task(lease_lost.wait())
    try:
        done, _ = await asyncio.wait(
            {task, cancel_wait, lost_wait},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if lost_wait in done and lease_lost.is_set():
            raise LeaseLost("The processor lease is no longer valid.")
        if cancel_wait in done and cancelled.is_set():
            raise JobCancelled("The job was cancelled by its owner.")
        return await task
    finally:
        for waiter in (cancel_wait, lost_wait):
            if not waiter.done():
                waiter.cancel()
        if not task.done():
            task.cancel()
        await asyncio.gather(task, cancel_wait, lost_wait, return_exceptions=True)


def _private_job_directory(scratch_root: str, user_id: str, job_id: str) -> Path:
    # The API creates UUIDs. Reject unexpected identifiers before using them as path segments.
    try:
        safe_user_id = str(uuid.UUID(user_id))
        safe_job_id = str(uuid.UUID(job_id))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("The claimed job contained an invalid identity.") from exc

    root = Path(scratch_root).expanduser()
    root.mkdir(parents=True, exist_ok=True, mode=0o700)
    root = root.resolve()
    users_dir = root / "users"
    user_dir = users_dir / safe_user_id
    job_dir = user_dir / safe_job_id
    for directory in (users_dir, user_dir, job_dir):
        if directory.exists() and directory.is_symlink():
            raise ValueError("Processor scratch paths must not be symlinks.")
        directory.mkdir(mode=0o700, exist_ok=True)
        directory.chmod(0o700)
        if not directory.resolve().is_relative_to(root):
            raise ValueError("Processor scratch path escaped its configured root.")
    return job_dir


def _write_manifest(job_dir: Path, job_id: str, user_id: str, source_asset_id: str, probe: object, audio_size: int) -> None:
    manifest = {
        "jobId": job_id,
        "userId": user_id,
        "sourceAssetId": source_asset_id,
        "audioFile": "audio.wav",
        "audioCodec": "pcm_s16le",
        "audioSampleRate": 16000,
        "audioChannels": 1,
        "audioSizeBytes": audio_size,
        "media": {
            "container": probe.container,
            "videoCodec": probe.video_codec,
            "sourceAudioCodec": probe.audio_codec,
            "width": probe.width,
            "height": probe.height,
            "durationSeconds": probe.duration_seconds,
            "sourceSampleRate": probe.source_sample_rate,
            "sourceChannels": probe.source_channels,
        },
    }
    temporary = job_dir / "media.json.partial"
    final = job_dir / "media.json"
    temporary.write_text(json.dumps(manifest, separators=(",", ":")), encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(final)


async def _render_heartbeat_loop(
    client: ProcessorClient,
    clip_id: str,
    lease_id: str,
    lease_token: str,
    stop: asyncio.Event,
    cancelled: asyncio.Event,
    lease_lost: asyncio.Event,
) -> None:
    while not stop.is_set():
        try:
            await asyncio.wait_for(stop.wait(), timeout=25)
            return
        except asyncio.TimeoutError:
            pass
        try:
            result = await client.render_heartbeat(clip_id, lease_id, lease_token)
        except Exception:
            lease_lost.set()
            return
        if result.get("cancelRequested") is True:
            cancelled.set()
            return


async def _run_render_once(client: ProcessorClient, settings: Settings) -> int:
    claimed = await client.claim_render(settings.worker_id)
    clip = claimed.get("clip")
    if clip is None:
        print("No queued VOD or clip-render jobs.")
        return 0

    lease = claimed["lease"]
    clip_id = clip["id"]
    job_id = clip["jobId"]
    user_id = clip["userId"]
    lease_id = lease["leaseId"]
    lease_token = lease["leaseToken"]
    try:
        safe_clip_id = str(uuid.UUID(clip_id))
    except (ValueError, TypeError, AttributeError) as exc:
        raise ValueError("The render queue returned an invalid clip identifier.") from exc

    stop_heartbeat = asyncio.Event()
    cancelled = asyncio.Event()
    lease_lost = asyncio.Event()
    heartbeat_task = asyncio.create_task(
        _render_heartbeat_loop(
            client, clip_id, lease_id, lease_token,
            stop_heartbeat, cancelled, lease_lost,
        )
    )

    try:
        job_dir = _private_job_directory(settings.scratch_dir, user_id, job_id)
        renders_dir = job_dir / "renders"
        if renders_dir.exists() and renders_dir.is_symlink():
            raise ValueError("Render output paths must not be symlinks.")
        renders_dir.mkdir(mode=0o700, exist_ok=True)
        renders_dir.chmod(0o700)

        try:
            options = json.loads(clip.get("renderOptionsJson") or "{}")
        except (TypeError, json.JSONDecodeError):
            options = {}
        if not isinstance(options, dict):
            options = {}
        captions = options.get("captions") is not False
        resolution = options.get("resolution", "1080x1920")
        if resolution not in {"1080x1920", "720x1280"}:
            resolution = "1080x1920"

        source_path = renders_dir / f"{safe_clip_id}.source"
        output_path = renders_dir / f"{safe_clip_id}.mp4"
        transcript_path = job_dir / "transcription" / "transcript.json"

        await _with_lease(
            client.render_progress(clip_id, lease_id, lease_token, 5),
            cancelled,
            lease_lost,
        )
        source_size = await _with_lease(
            client.download_render_source(
                clip_id, lease_id, lease_token, source_path,
                max_bytes=2_147_483_648,
            ),
            cancelled,
            lease_lost,
        )
        await _with_lease(
            client.render_progress(clip_id, lease_id, lease_token, 15),
            cancelled,
            lease_lost,
        )

        result = await _with_lease(
            render_clip(
                source_path,
                transcript_path,
                output_path,
                start_seconds=float(clip["startSeconds"]),
                end_seconds=float(clip["endSeconds"]),
                captions=captions,
                resolution=resolution,
                ffmpeg_binary=settings.ffmpeg_binary,
                ffprobe_binary=settings.ffprobe_binary,
                timeout_seconds=settings.render_timeout_seconds,
                threads=settings.ffmpeg_threads,
            ),
            cancelled,
            lease_lost,
        )
        await _with_lease(
            client.render_progress(clip_id, lease_id, lease_token, 75),
            cancelled,
            lease_lost,
        )

        upload = await _with_lease(
            client.render_upload_init(
                clip_id, lease_id, lease_token, result.size_bytes
            ),
            cancelled,
            lease_lost,
        )
        part_size = upload.get("partSizeBytes")
        part_count = upload.get("partCount")
        uploaded_parts = upload.get("uploadedParts")
        expected_parts = (result.size_bytes + 8 * 1024 * 1024 - 1) // (8 * 1024 * 1024)
        if (
            part_size != 8 * 1024 * 1024
            or part_count != expected_parts
            or not isinstance(uploaded_parts, list)
        ):
            raise ClipRenderError("clip_upload_session_invalid", "The private output upload session is invalid.")

        completed_parts = {
            item.get("partNumber")
            for item in uploaded_parts
            if isinstance(item, dict) and isinstance(item.get("partNumber"), int)
        }
        with output_path.open("rb") as source:
            for part_number in range(1, part_count + 1):
                if part_number in completed_parts:
                    continue
                chunk = source.read(part_size)
                expected_size = min(part_size, result.size_bytes - (part_number - 1) * part_size)
                if len(chunk) != expected_size:
                    raise ClipRenderError("clip_output_read_failed", "The rendered MP4 changed during upload.")
                await _with_lease(
                    client.upload_render_part(
                        clip_id, lease_id, lease_token, part_number, chunk
                    ),
                    cancelled,
                    lease_lost,
                )
                progress = 76 + round(18 * part_number / max(1, part_count))
                await _with_lease(
                    client.render_progress(clip_id, lease_id, lease_token, min(95, progress)),
                    cancelled,
                    lease_lost,
                )
        completion = await _with_lease(
            client.render_complete(clip_id, lease_id, lease_token),
            cancelled,
            lease_lost,
        )
        source_path.unlink(missing_ok=True)
        output_path.unlink(missing_ok=True)
        output_path.with_suffix(".ass").unlink(missing_ok=True)
        print(
            "Clip rendering finished:",
            json.dumps(
                {
                    "clipId": clip_id,
                    "jobId": job_id,
                    "sourceBytes": source_size,
                    "outputBytes": result.size_bytes,
                    "durationSeconds": result.duration_seconds,
                    "resolution": f"{result.width}x{result.height}",
                    "captions": captions,
                    "status": completion.get("status", "ready"),
                },
                ensure_ascii=False,
            ),
        )
        return 0
    except JobCancelled:
        await client.render_fail(clip_id, lease_id, lease_token, "cancelled_by_user")
        print("Clip render cancelled:", json.dumps({"clipId": clip_id}))
        return 0
    except LeaseLost:
        print("Clip render lease lost; stopping without modifying the clip.")
        return 0
    except Exception as exc:
        code = getattr(exc, "code", None)
        if not isinstance(code, str) or not re.fullmatch(r"[a-z0-9_]{1,60}", code):
            code = "clip_render_failed"
        try:
            result = await client.render_fail(clip_id, lease_id, lease_token, code)
        except Exception:
            result = {"accepted": False}
        print(
            "Clip rendering failed:",
            json.dumps({"clipId": clip_id, "errorCode": code, "result": result}),
        )
        return 0
    finally:
        stop_heartbeat.set()
        heartbeat_task.cancel()
        await asyncio.gather(heartbeat_task, return_exceptions=True)


async def run_once() -> int:
    """Inspect one VOD, validate its owner-provided file, and retain normalized audio in private scratch."""
    settings = Settings.from_env()
    client = ProcessorClient(
        settings.api_base_url,
        settings.shared_secret,
        settings.http_timeout_seconds,
    )

    try:
        ping = await client.ping()
        print("API authenticated:", json.dumps(ping, ensure_ascii=False))

        claimed = await client.claim(settings.worker_id)
        job = claimed.get("job")
        if job is None:
            return await _run_render_once(client, settings)

        lease = claimed["lease"]
        job_id = job["id"]
        user_id = job["userId"]
        source_asset_id = job["sourceAssetId"]
        lease_id = lease["leaseId"]
        lease_token = lease["leaseToken"]
        stop_heartbeat = asyncio.Event()
        cancelled = asyncio.Event()
        lease_lost = asyncio.Event()
        heartbeat_task = asyncio.create_task(
            _heartbeat_loop(client, job_id, lease_id, lease_token, stop_heartbeat, cancelled, lease_lost)
        )

        try:
            job_dir = _private_job_directory(settings.scratch_dir, user_id, job_id)
            source_path = job_dir / "source.upload"
            audio_path = job_dir / "audio.wav"

            metadata = await _with_lease(
                inspect_video_url(
                    job["sourceUrl"],
                    youtube_api_key=settings.youtube_data_api_key,
                    twitch_client_id=settings.twitch_client_id,
                    twitch_client_secret=settings.twitch_client_secret,
                ),
                cancelled,
                lease_lost,
            )
            await _with_lease(
                client.report_source_metadata(
                    job_id, lease_id, lease_token,
                    source_id=metadata.source_id,
                    source_platform=metadata.platform,
                    source_type=metadata.source_type,
                    title=metadata.title,
                    duration_seconds=metadata.duration_seconds,
                    published_at=metadata.published_at,
                ),
                cancelled,
                lease_lost,
            )

            if metadata.source_type == "live":
                result = await client.fail(job_id, lease_id, lease_token, "live_source_not_supported")
                outcome = "live_source_not_supported"
                print("Source inspection finished:", json.dumps({"jobId": job_id, "outcome": outcome, "result": result}))
                return 0

            await _with_lease(
                client.report_progress(job_id, lease_id, lease_token, "downloading_source", 8),
                cancelled,
                lease_lost,
            )
            source_size = await _with_lease(
                client.download_source_asset(
                    job_id, lease_id, lease_token, source_path,
                    max_bytes=2_147_483_648,
                ),
                cancelled,
                lease_lost,
            )

            await _with_lease(
                client.report_progress(job_id, lease_id, lease_token, "validating_media", 12),
                cancelled,
                lease_lost,
            )
            probe = await _with_lease(
                probe_media(
                    source_path,
                    ffprobe_binary=settings.ffprobe_binary,
                    timeout_seconds=settings.ffprobe_timeout_seconds,
                    max_duration_seconds=settings.max_video_duration_seconds,
                ),
                cancelled,
                lease_lost,
            )

            await _with_lease(
                client.report_progress(job_id, lease_id, lease_token, "extracting_audio", 20),
                cancelled,
                lease_lost,
            )
            audio_size = await _with_lease(
                extract_audio(
                    source_path,
                    audio_path,
                    ffmpeg_binary=settings.ffmpeg_binary,
                    timeout_seconds=settings.ffmpeg_timeout_seconds,
                    max_audio_bytes=settings.max_audio_bytes,
                    threads=settings.ffmpeg_threads,
                ),
                cancelled,
                lease_lost,
            )
            _write_manifest(job_dir, job_id, user_id, source_asset_id, probe, audio_size)
            source_path.unlink(missing_ok=True)

            await _with_lease(
                client.report_progress(job_id, lease_id, lease_token, "transcribing_audio", 35),
                cancelled,
                lease_lost,
            )
            transcription = await _with_lease(
                run_transcription_process(
                    client,
                    job_id=job_id,
                    lease_id=lease_id,
                    lease_token=lease_token,
                    audio_path=audio_path,
                    output_dir=job_dir / "transcription",
                    source_asset_id=source_asset_id,
                    duration_seconds=probe.duration_seconds,
                    settings=settings,
                ),
                cancelled,
                lease_lost,
            )
            await _with_lease(
                client.report_progress(job_id, lease_id, lease_token, "finalizing_transcript", 59),
                cancelled,
                lease_lost,
            )
            await _with_lease(
                client.report_transcription_ready(
                    job_id, lease_id, lease_token,
                    container=probe.container,
                    video_codec=probe.video_codec,
                    source_audio_codec=probe.audio_codec,
                    width=probe.width,
                    height=probe.height,
                    duration_seconds=probe.duration_seconds,
                    audio_size_bytes=audio_size,
                    transcript_model=transcription["model"],
                    transcript_language=transcription["language"],
                    transcript_segment_count=transcription["segment_count"],
                    transcript_size_bytes=transcription["size_bytes"],
                    transcript_sha256=transcription["sha256"],
                ),
                cancelled,
                lease_lost,
            )
            await _with_lease(
                client.report_progress(job_id, lease_id, lease_token, "analyzing_moments", 62),
                cancelled,
                lease_lost,
            )
            candidates = await _with_lease(
                run_moment_process(
                    audio_path=audio_path,
                    transcript_path=Path(transcription["path"]),
                    output_path=job_dir / "moments.json",
                    settings=settings,
                ),
                cancelled,
                lease_lost,
            )
            await _with_lease(
                client.report_progress(job_id, lease_id, lease_token, "saving_moments", 72),
                cancelled,
                lease_lost,
            )
            result = await _with_lease(
                client.report_moments_ready(
                    job_id, lease_id, lease_token,
                    candidates=candidates,
                ),
                cancelled,
                lease_lost,
            )
            # Audio, transcript and moments remain private processor artifacts for rendering.
            print(
                "Media preparation finished:",
                json.dumps(
                    {
                        "jobId": job_id,
                        "sourceBytes": source_size,
                        "durationSeconds": probe.duration_seconds,
                        "resolution": f"{probe.width}x{probe.height}",
                        "audioBytes": audio_size,
                        "audioPath": str(audio_path),
                        "transcriptPath": transcription["path"],
                        "transcriptSegments": transcription["segment_count"],
                        "transcriptLanguage": transcription["language"],
                        "candidateCount": len(candidates),
                        "outcome": "moments_detected",
                        "result": result,
                    },
                    ensure_ascii=False,
                ),
            )
            return 0
        except JobCancelled:
            result = await client.fail(job_id, lease_id, lease_token, "cancelled_by_user")
            print("Job cancelled:", json.dumps({"jobId": job_id, "result": result}))
            return 0
        except LeaseLost:
            # A replacement worker may now own this job. Do not mutate its state.
            print("Processor lease lost; stopping without modifying the job.")
            return 0
        except Exception as exc:
            code = getattr(exc, "code", None)
            if not isinstance(code, str) or not re.fullmatch(r"[a-z0-9_]{1,60}", code):
                code = "media_processing_failed"
            try:
                result = await client.fail(job_id, lease_id, lease_token, code)
            except Exception:
                result = {"accepted": False}
            print("Media preparation failed:", json.dumps({"jobId": job_id, "errorCode": code, "result": result}))
            return 0
        finally:
            stop_heartbeat.set()
            heartbeat_task.cancel()
            await asyncio.gather(heartbeat_task, return_exceptions=True)
    finally:
        await client.close()


async def run_forever() -> None:
    """Continuously poll the D1-backed queue without running concurrent jobs."""
    settings = Settings.from_env()
    print(
        "ClipForge processor online:",
        json.dumps(
            {
                "workerId": settings.worker_id,
                "pollIntervalSeconds": settings.poll_interval_seconds,
                "scratchDir": settings.scratch_dir,
            }
        ),
        flush=True,
    )
    while True:
        try:
            await run_once()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            # Do not print request bodies, signed headers, tokens or provider secrets.
            print(
                "Processor cycle could not start:",
                json.dumps({"errorType": type(exc).__name__}),
                flush=True,
            )
        await asyncio.sleep(settings.poll_interval_seconds)


if __name__ == "__main__":
    try:
        asyncio.run(run_forever())
    except KeyboardInterrupt:
        print("ClipForge processor stopped.", flush=True)
