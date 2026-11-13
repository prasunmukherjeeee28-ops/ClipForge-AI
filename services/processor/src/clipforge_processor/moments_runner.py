from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from .config import Settings
from .moments import MomentDetectionError


MAX_CANDIDATE_FILE_BYTES = 2_000_000


async def run_moment_process(
    *,
    audio_path: Path,
    transcript_path: Path,
    output_path: Path,
    settings: Settings,
) -> list[dict[str, Any]]:
    """Run CPU candidate analysis outside the async heartbeat event loop."""
    command = [
        sys.executable,
        "-m", "clipforge_processor.moments_cli",
        "--audio", str(audio_path),
        "--transcript", str(transcript_path),
        "--output", str(output_path),
        "--max-results", "50",
    ]
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except OSError as exc:
        raise MomentDetectionError(
            "moment_worker_unavailable",
            "The local moment-analysis process could not be started.",
        ) from exc

    try:
        try:
            stdout, _ = await asyncio.wait_for(
                process.communicate(),
                timeout=settings.moments_timeout_seconds,
            )
        except asyncio.TimeoutError as exc:
            raise MomentDetectionError(
                "moment_analysis_timeout",
                "Candidate analysis exceeded its configured time limit.",
            ) from exc

        if process.returncode != 0 or len(stdout) > 4096:
            raise MomentDetectionError(
                "moment_analysis_failed",
                "The candidate-analysis process did not complete successfully.",
            )
        try:
            result = json.loads(stdout.decode("utf-8").strip())
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise MomentDetectionError(
                "moment_analysis_protocol_error",
                "The candidate-analysis process returned an invalid result.",
            ) from exc
        if not isinstance(result, dict) or result.get("event") != "complete":
            raise MomentDetectionError(
                "moment_analysis_protocol_error",
                "The candidate-analysis process did not report completion.",
            )

        if output_path.is_symlink() or not output_path.is_file():
            raise MomentDetectionError(
                "moment_output_missing",
                "The candidate-analysis output file is missing.",
            )
        if output_path.stat().st_size > MAX_CANDIDATE_FILE_BYTES:
            raise MomentDetectionError(
                "moment_output_limit_exceeded",
                "The candidate output exceeded its configured size limit.",
            )
        try:
            candidates = json.loads(output_path.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise MomentDetectionError(
                "moment_output_invalid",
                "The candidate output could not be parsed.",
            ) from exc
        if not isinstance(candidates, list) or len(candidates) > 50:
            raise MomentDetectionError(
                "moment_output_invalid",
                "The candidate list is outside supported limits.",
            )
        if result.get("candidateCount") != len(candidates):
            raise MomentDetectionError(
                "moment_output_invalid",
                "The candidate count did not match the output artifact.",
            )
        return candidates
    finally:
        if process.returncode is None:
            process.terminate()
            try:
                await asyncio.wait_for(process.wait(), timeout=5)
            except asyncio.TimeoutError:
                process.kill()
                await process.wait()
