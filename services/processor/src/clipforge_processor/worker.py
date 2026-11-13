from __future__ import annotations

import asyncio
import json
import re
import signal
import shutil
import threading
import uuid
from pathlib import Path
from typing import Awaitable, TypeVar

from .client import ProcessorClient
from .config import Settings
from .media import MediaProcessingError, extract_audio, probe_media
from .moments import detect_moments
from .moment_scoring import LocalHeuristicAdapter, MomentEvidence
from .semantic_scoring import GeminiSemanticAdapter
from .render import render_vertical_clip
from .source_adapters import SourceInspectionError, inspect_video_url
from .transcription_runner import run_transcription_process

T = TypeVar("T")


def _select_render_candidates(candidates: list[dict[str, object]], limit: int = 3) -> list[dict[str, object]]:
    ranked = sorted(
        (item for item in candidates
         if isinstance(item.get("startSeconds"), (int, float))
         and isinstance(item.get("endSeconds"), (int, float))
         and isinstance(item.get("score"), (int, float))
         and 5 <= float(item["endSeconds"]) - float(item["startSeconds"]) <= 120),
        key=lambda item: (-float(item["score"]), float(item["startSeconds"])),
    )
    selected: list[dict[str, object]] = []
    for candidate in ranked:
        start = float(candidate["startSeconds"])
        end = float(candidate["endSeconds"])
        overlaps = any(
            max(0.0, min(end, float(item["endSeconds"])) - max(start, float(item["startSeconds"])))
            / (max(end, float(item["endSeconds"])) - min(start, float(item["startSeconds"]))) > 0.45
            for item in selected
        )
        if not overlaps:
            selected.append(candidate)
        if len(selected) >= limit:
            break
    return selected


def _clip_title(transcript_path: Path, start_seconds: float, end_seconds: float, index: int, title_hint: str | None = None) -> str:
    if isinstance(title_hint, str) and title_hint.strip():
        clean_hint = re.sub(r"[\x00-\x1f\x7f]", " ", title_hint).strip()
        clean_hint = " ".join(clean_hint.split())[:116].rstrip(" .!?")
        if clean_hint:
            return clean_hint
    try:
        payload = json.loads(transcript_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        payload = {}
    segments = payload.get("segments") if isinstance(payload, dict) else None
    snippets: list[str] = []
    if isinstance(segments, list):
        for segment in segments:
            if not isinstance(segment, dict) or not isinstance(segment.get("text"), str):
                continue
            try:
                start = float(segment.get("start"))
                end = float(segment.get("end"))
            except (TypeError, ValueError, OverflowError):
                continue
            if end > start_seconds and start < end_seconds:
                cleaned = " ".join(segment["text"].split())
                if cleaned:
                    snippets.append(cleaned)
            if len(" ".join(snippets)) >= 100:
                break
    excerpt = re.sub(r"[\x00-\x1f\x7f]", " ", " ".join(snippets)).strip()
    excerpt = " ".join(excerpt.split())
    if excerpt:
        sentence = re.split(r"(?<=[.!?])\s+", excerpt, maxsplit=1)[0]
        return sentence[:116].rstrip(" .!?") or f"Highlight {index}"
    return f"Gameplay highlight {index}"



def _build_semantic_evidence(candidates: list[dict[str, object]], transcript_path: Path) -> list[MomentEvidence]:
    """Attach only bounded candidate-local transcript excerpts to semantic evidence."""
    try:
        payload = json.loads(transcript_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        payload = {}
    segments = payload.get("segments") if isinstance(payload, dict) else None
    if not isinstance(segments, list):
        segments = []

    evidence: list[MomentEvidence] = []
    for candidate in candidates:
        try:
            start = float(candidate["startSeconds"])
            end = float(candidate["endSeconds"])
            score = float(candidate["score"])
            signals = candidate["signals"]
            if not isinstance(signals, dict):
                continue
            excerpt_parts: list[str] = []
            excerpt_length = 0
            for segment in segments:
                if not isinstance(segment, dict) or not isinstance(segment.get("text"), str):
                    continue
                try:
                    segment_start = float(segment.get("start"))
                    segment_end = float(segment.get("end"))
                except (TypeError, ValueError, OverflowError):
                    continue
                if segment_end <= start or segment_start >= end:
                    continue
                text = " ".join(segment["text"].split())
                if not text:
                    continue
                remaining = 1600 - excerpt_length
                if remaining <= 0:
                    break
                excerpt_parts.append(text[:remaining])
                excerpt_length += min(len(text), remaining) + 1
            evidence.append(MomentEvidence(
                start_seconds=start,
                end_seconds=end,
                heuristic_score=score,
                acoustic_salience=float(signals["acousticSalience"]),
                transcript_velocity=float(signals["transcriptVelocity"]),
                narrative_arc=float(signals["narrativeArc"]),
                novelty=float(signals["novelty"]),
                word_count=int(candidate["wordCount"]),
                marker_count=int(candidate["markerCount"]),
                rationale=str(candidate.get("rationale") or "combined audio and transcript cues")[:500],
                transcript_excerpt=" ".join(excerpt_parts)[:1600],
            ))
        except (KeyError, TypeError, ValueError, OverflowError):
            continue
    return evidence


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
            print("No queued jobs.")
            return 0

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
        job_dir: Path | None = None

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
                client.report_progress(job_id, lease_id, lease_token, "analyzing_moments", 63),
                cancelled,
                lease_lost,
            )
            candidates = await _with_lease(
                asyncio.to_thread(
                    detect_moments,
                    audio_path,
                    Path(transcription["path"]),
                    max_results=100,
                ),
                cancelled,
                lease_lost,
            )
            candidate_payload = []
            for candidate in candidates:
                item = candidate.as_dict()
                item["candidateId"] = str(uuid.uuid5(
                    uuid.NAMESPACE_URL,
                    f"clipforge:{job_id}:{item['startSeconds']:.3f}:{item['endSeconds']:.3f}",
                ))
                candidate_payload.append(item)

            # Keep the deterministic detector as the safety net. Gemini receives only
            # the top heuristic candidates and their bounded transcript excerpts.
            semantic_evidence = _build_semantic_evidence(candidate_payload, Path(transcription["path"]))
            semantic_results = LocalHeuristicAdapter().score(semantic_evidence)
            if settings.semantic_api_key and semantic_evidence:
                try:
                    semantic_adapter = GeminiSemanticAdapter(
                        settings.semantic_api_key,
                        model=settings.semantic_model,
                        timeout_seconds=settings.semantic_timeout_seconds,
                    )
                    semantic_results = await _with_lease(
                        asyncio.to_thread(semantic_adapter.score, semantic_evidence),
                        cancelled,
                        lease_lost,
                    )
                    print("Gemini semantic refinement completed:", len(semantic_results))
                except Exception as exc:
                    # Provider outages, quota limits and malformed model output must not
                    # fail an otherwise valid clip job or interrupt the active lease.
                    print("Gemini semantic refinement unavailable; using local scores:", type(exc).__name__)

            semantic_by_window = {
                (round(result.start_seconds, 3), round(result.end_seconds, 3)): result
                for result in semantic_results
            }
            for item in candidate_payload:
                result = semantic_by_window.get((
                    round(float(item["startSeconds"]), 3),
                    round(float(item["endSeconds"]), 3),
                ))
                if result is not None:
                    item["score"] = result.score
                    item["rationale"] = f"{result.category}: {result.rationale}"[:500]
                    if result.title_hint:
                        item["titleHint"] = result.title_hint
            await _with_lease(
                client.report_progress(job_id, lease_id, lease_token, "persisting_moments", 68),
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
                    candidates=candidate_payload,
                ),
                cancelled,
                lease_lost,
            )

            selected = _select_render_candidates(candidate_payload, limit=3)
            clip_ids: list[str] = []
            clips_dir = job_dir / "clips"
            clips_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
            clips_dir.chmod(0o700)

            for index, candidate in enumerate(selected, start=1):
                start_seconds = float(candidate["startSeconds"])
                end_seconds = float(candidate["endSeconds"])
                title = _clip_title(Path(transcription["path"]), start_seconds, end_seconds, index, candidate.get("titleHint") if isinstance(candidate.get("titleHint"), str) else None)
                output_path = clips_dir / f"clip-{index:02d}.mp4"
                await _with_lease(
                    client.report_progress(
                        job_id, lease_id, lease_token, "rendering_clips",
                        72 + round(10 * (index - 1) / max(1, len(selected))),
                    ),
                    cancelled,
                    lease_lost,
                )
                render_cancel = threading.Event()
                try:
                    rendered = await _with_lease(
                        asyncio.to_thread(
                            render_vertical_clip,
                            source_path,
                            Path(transcription["path"]),
                            output_path,
                            start_seconds=start_seconds,
                            end_seconds=end_seconds,
                            ffmpeg_binary=settings.ffmpeg_binary,
                            timeout_seconds=min(settings.ffmpeg_timeout_seconds, 3600),
                            max_output_bytes=500_000_000,
                            threads=settings.ffmpeg_threads,
                            cancel_event=render_cancel,
                        ),
                        cancelled,
                        lease_lost,
                    )
                except BaseException:
                    render_cancel.set()
                    raise

                upload = await _with_lease(
                    client.begin_clip_upload(
                        job_id, lease_id, lease_token,
                        start_seconds=start_seconds,
                        end_seconds=end_seconds,
                        title=title,
                        size_bytes=rendered.size_bytes,
                    ),
                    cancelled,
                    lease_lost,
                )
                clip_upload_id = upload.get("clipUploadId")
                upload_part_size = upload.get("partSizeBytes")
                upload_part_count = upload.get("partCount")
                if not isinstance(clip_upload_id, str) or not isinstance(upload_part_size, int) or not isinstance(upload_part_count, int):
                    raise RuntimeError("clip_upload_initialization_invalid")
                if upload.get("stored") is not True:
                    if upload_part_size < 5 * 1024 * 1024 or upload_part_size > 8 * 1024 * 1024:
                        raise RuntimeError("clip_upload_part_size_invalid")
                    with output_path.open("rb") as clip_file:
                        for part_number in range(1, upload_part_count + 1):
                            chunk = await asyncio.to_thread(clip_file.read, upload_part_size)
                            if not chunk:
                                raise RuntimeError("clip_upload_part_missing")
                            await _with_lease(
                                client.upload_clip_part(
                                    job_id, lease_id, lease_token, clip_upload_id, part_number, chunk
                                ),
                                cancelled,
                                lease_lost,
                            )
                    await _with_lease(
                        client.complete_clip_upload(job_id, lease_id, lease_token, clip_upload_id),
                        cancelled,
                        lease_lost,
                    )
                clip_ids.append(clip_upload_id)
                output_path.unlink(missing_ok=True)

            await _with_lease(
                client.report_progress(job_id, lease_id, lease_token, "finalizing_clips", 96),
                cancelled,
                lease_lost,
            )
            result = await _with_lease(
                client.report_clips_ready(job_id, lease_id, lease_token, clip_ids),
                cancelled,
                lease_lost,
            )
            source_path.unlink(missing_ok=True)
            print(
                "Clip generation finished:",
                json.dumps(
                    {
                        "jobId": job_id,
                        "sourceBytes": source_size,
                        "durationSeconds": probe.duration_seconds,
                        "resolution": f"{probe.width}x{probe.height}",
                        "audioBytes": audio_size,
                        "transcriptSegments": transcription["segment_count"],
                        "candidateCount": len(candidate_payload),
                        "clipCount": len(clip_ids),
                        "outcome": "completed",
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
        except asyncio.CancelledError:
            # A service shutdown is not a user cancellation. Release the lease so
            # the job can be claimed promptly by the next processor instance.
            try:
                await client.release(job_id, lease_id, lease_token)
            except Exception as release_error:
                print(
                    "Processor shutdown could not release the lease; it will expire:",
                    type(release_error).__name__,
                )
            raise
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
            if job_dir is not None:
                # Source media, transcripts and rendered clips are private user data.
                # Never retain processor scratch artifacts after a job cycle.
                shutil.rmtree(job_dir, ignore_errors=True)
    finally:
        await client.close()


async def run_forever(
    poll_interval_seconds: float = 10.0,
    *,
    stop_event: asyncio.Event | None = None,
    register_signal_handlers: bool = True,
) -> int:
    """Continuously claim one job at a time until SIGINT/SIGTERM or stop_event."""
    if not 1.0 <= poll_interval_seconds <= 300.0:
        raise ValueError("poll_interval_seconds must be between 1 and 300")

    stop = stop_event or asyncio.Event()
    loop = asyncio.get_running_loop()
    installed_signals: list[signal.Signals] = []
    if register_signal_handlers:
        for signum in (signal.SIGINT, signal.SIGTERM):
            try:
                loop.add_signal_handler(signum, stop.set)
                installed_signals.append(signum)
            except (NotImplementedError, RuntimeError):
                # Signal handlers are not available on every event-loop platform.
                continue

    try:
        while not stop.is_set():
            cycle_task = asyncio.create_task(run_once(), name="clipforge-processor-cycle")
            stop_task = asyncio.create_task(stop.wait(), name="clipforge-processor-stop")
            try:
                done, _ = await asyncio.wait(
                    {cycle_task, stop_task},
                    return_when=asyncio.FIRST_COMPLETED,
                )
                if stop_task in done and stop.is_set():
                    cycle_task.cancel()
                    await asyncio.gather(cycle_task, return_exceptions=True)
                    break
                await cycle_task
            finally:
                if not cycle_task.done():
                    cycle_task.cancel()
                if not stop_task.done():
                    stop_task.cancel()
                await asyncio.gather(cycle_task, stop_task, return_exceptions=True)

            if not stop.is_set():
                try:
                    await asyncio.wait_for(stop.wait(), timeout=poll_interval_seconds)
                except asyncio.TimeoutError:
                    pass
        return 0
    finally:
        for signum in installed_signals:
            loop.remove_signal_handler(signum)


async def main() -> int:
    settings = Settings.from_env()
    return await run_forever(settings.poll_interval_seconds)


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
