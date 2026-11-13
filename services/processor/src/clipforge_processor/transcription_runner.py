from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path
from typing import Any

from .client import ProcessorClient
from .config import Settings
from .transcription import TranscriptionError


async def run_transcription_process(
    client: ProcessorClient,
    *,
    job_id: str,
    lease_id: str,
    lease_token: str,
    audio_path: Path,
    output_dir: Path,
    source_asset_id: str,
    duration_seconds: float,
    settings: Settings,
) -> dict[str, Any]:
    """Run cancellable, checkpointed local ASR in a child process while reporting lease progress."""
    command = [
        sys.executable,
        "-m", "clipforge_processor.transcribe_cli",
        "--audio", str(audio_path),
        "--output-dir", str(output_dir),
        "--source-asset-id", source_asset_id,
        "--duration", str(duration_seconds),
        "--model", settings.stt_model,
        "--model-cache-dir", settings.stt_model_cache_dir,
        "--cpu-threads", str(settings.stt_cpu_threads),
        "--chunk-seconds", str(settings.stt_chunk_seconds),
        "--beam-size", str(settings.stt_beam_size),
        "--ffmpeg", settings.ffmpeg_binary,
    ]
    if settings.stt_language:
        command.extend(["--language", settings.stt_language])

    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError as exc:
        raise TranscriptionError(
            "transcription_worker_unavailable",
            "The isolated transcription process could not be started.",
        ) from exc

    completed_event: dict[str, Any] | None = None
    try:
        assert process.stdout is not None
        while True:
            try:
                line = await asyncio.wait_for(
                    process.stdout.readline(),
                    timeout=settings.stt_chunk_timeout_seconds,
                )
            except asyncio.TimeoutError as exc:
                raise TranscriptionError(
                    "transcription_chunk_timeout",
                    "Speech recognition did not complete an audio chunk within the configured limit.",
                ) from exc
            if not line:
                break
            try:
                event = json.loads(line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError) as exc:
                raise TranscriptionError(
                    "transcription_worker_protocol_error",
                    "The transcription process returned an invalid progress event.",
                ) from exc
            if not isinstance(event, dict):
                raise TranscriptionError(
                    "transcription_worker_protocol_error",
                    "The transcription process returned an invalid progress event.",
                )

            if event.get("event") == "progress":
                completed = event.get("completedChunks")
                total = event.get("totalChunks")
                if (
                    isinstance(completed, int) and isinstance(total, int)
                    and total > 0 and 0 <= completed <= total
                ):
                    progress = min(59, 35 + round(24 * completed / total))
                    await client.report_progress(
                        job_id, lease_id, lease_token, "transcribing_audio", progress
                    )
            elif event.get("event") == "complete":
                completed_event = event
            elif event.get("event") == "error":
                code = event.get("code")
                if not isinstance(code, str) or not re.fullmatch(r"[a-z0-9_]{1,60}", code):
                    code = "transcription_failed"
                raise TranscriptionError(code, "Speech recognition could not complete this job.")

        return_code = await process.wait()
        if return_code != 0 or completed_event is None:
            raise TranscriptionError(
                "transcription_failed",
                "Speech recognition exited without a verified transcript result.",
            )

        model = completed_event.get("model")
        language = completed_event.get("language")
        segment_count = completed_event.get("segmentCount")
        size_bytes = completed_event.get("sizeBytes")
        digest = completed_event.get("sha256")
        if (
            model != settings.stt_model
            or (language is not None and (not isinstance(language, str) or len(language) > 12))
            or not isinstance(segment_count, int) or segment_count < 0 or segment_count > 500000
            or not isinstance(size_bytes, int) or size_bytes < 2 or size_bytes > 100000000
            or not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest)
        ):
            raise TranscriptionError(
                "transcription_result_invalid",
                "The transcription process returned invalid transcript metadata.",
            )
        return {
            "model": model,
            "language": language,
            "segment_count": segment_count,
            "size_bytes": size_bytes,
            "sha256": digest,
            "path": str(output_dir / "transcript.json"),
        }
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
