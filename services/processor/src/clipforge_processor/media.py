from __future__ import annotations

import asyncio
import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class MediaProcessingError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class MediaProbe:
    container: str
    duration_seconds: float
    video_codec: str
    audio_codec: str
    width: int
    height: int
    source_sample_rate: int | None
    source_channels: int | None


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return parsed if parsed > 0 else None


def parse_probe_output(
    payload: str,
    *,
    max_duration_seconds: int = 43_200,
    max_width: int = 7680,
    max_height: int = 4320,
) -> MediaProbe:
    """Validate a deliberately small FFprobe JSON projection."""
    try:
        document = json.loads(payload)
    except (json.JSONDecodeError, TypeError) as exc:
        raise MediaProcessingError("invalid_media_probe", "FFprobe returned invalid JSON.") from exc

    if not isinstance(document, dict):
        raise MediaProcessingError("invalid_media_probe", "FFprobe output must be a JSON object.")
    streams = document.get("streams")
    if not isinstance(streams, list) or len(streams) > 64:
        raise MediaProcessingError("invalid_media_probe", "The media has an invalid stream layout.")

    video = next((item for item in streams if isinstance(item, dict) and item.get("codec_type") == "video"), None)
    audio = next((item for item in streams if isinstance(item, dict) and item.get("codec_type") == "audio"), None)
    if video is None:
        raise MediaProcessingError("media_missing_video", "The uploaded file has no video stream.")
    if audio is None:
        raise MediaProcessingError("media_missing_audio", "The uploaded file has no audio stream.")

    width = _positive_int(video.get("width"))
    height = _positive_int(video.get("height"))
    if width is None or height is None or width > max_width or height > max_height:
        raise MediaProcessingError("media_dimensions_unsupported", "The video dimensions are outside the supported range.")

    format_info = document.get("format") if isinstance(document.get("format"), dict) else {}
    duration_values = [format_info.get("duration"), video.get("duration"), audio.get("duration")]
    duration: float | None = None
    for value in duration_values:
        try:
            candidate = float(value)
        except (TypeError, ValueError, OverflowError):
            continue
        if math.isfinite(candidate) and candidate > 0:
            duration = candidate
            break
    if duration is None or duration > max_duration_seconds:
        raise MediaProcessingError("media_duration_unsupported", "The video duration is missing or exceeds the processing limit.")

    container = format_info.get("format_name")
    video_codec = video.get("codec_name")
    audio_codec = audio.get("codec_name")
    if not all(isinstance(value, str) and 1 <= len(value) <= 100 for value in (container, video_codec, audio_codec)):
        raise MediaProcessingError("invalid_media_probe", "FFprobe did not identify supported media metadata.")

    return MediaProbe(
        container=container,
        duration_seconds=round(duration, 3),
        video_codec=video_codec,
        audio_codec=audio_codec,
        width=width,
        height=height,
        source_sample_rate=_positive_int(audio.get("sample_rate")),
        source_channels=_positive_int(audio.get("channels")),
    )


async def _communicate_with_timeout(
    process: asyncio.subprocess.Process,
    timeout_seconds: float,
) -> tuple[bytes, bytes]:
    try:
        return await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
    except asyncio.TimeoutError as exc:
        process.kill()
        await process.communicate()
        raise MediaProcessingError("media_processing_timeout", "The media operation exceeded its time limit.") from exc
    except asyncio.CancelledError:
        if process.returncode is None:
            process.kill()
            await process.communicate()
        raise


async def probe_media(
    source_path: Path,
    *,
    ffprobe_binary: str = "ffprobe",
    timeout_seconds: float = 30,
    max_duration_seconds: int = 43_200,
    max_width: int = 7680,
    max_height: int = 4320,
) -> MediaProbe:
    if not source_path.is_file() or source_path.stat().st_size < 1:
        raise MediaProcessingError("source_file_missing", "The downloaded source file is missing or empty.")
    command = [
        ffprobe_binary,
        "-v", "error",
        "-protocol_whitelist", "file,pipe",
        "-show_entries",
        "format=format_name,duration:stream=codec_type,codec_name,width,height,sample_rate,channels,duration",
        "-of", "json",
        str(source_path.resolve()),
    ]
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise MediaProcessingError("ffprobe_unavailable", "FFprobe is not installed or is not on PATH.") from exc
    stdout, stderr = await _communicate_with_timeout(process, timeout_seconds)
    if process.returncode != 0:
        # Do not return raw media parser diagnostics to the user or API.
        raise MediaProcessingError("invalid_media_file", "FFprobe could not read the uploaded media file.")
    try:
        decoded = stdout.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise MediaProcessingError("invalid_media_probe", "FFprobe returned non-UTF-8 output.") from exc
    return parse_probe_output(
        decoded,
        max_duration_seconds=max_duration_seconds,
        max_width=max_width,
        max_height=max_height,
    )


async def extract_audio(
    source_path: Path,
    audio_path: Path,
    *,
    ffmpeg_binary: str = "ffmpeg",
    timeout_seconds: float = 3600,
    max_audio_bytes: int = 1_500_000_000,
    threads: int = 2,
) -> int:
    if threads < 1 or threads > 4:
        raise ValueError("threads must be between 1 and 4")
    audio_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    temporary_path = audio_path.with_name(audio_path.name + ".partial")
    temporary_path.unlink(missing_ok=True)
    command = [
        ffmpeg_binary,
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-xerror",
        "-protocol_whitelist", "file,pipe",
        "-threads", str(threads),
        "-i", str(source_path.resolve()),
        "-map", "0:a:0",
        "-vn", "-sn", "-dn",
        "-map_metadata", "-1",
        "-map_chapters", "-1",
        "-ac", "1",
        "-ar", "16000",
        "-c:a", "pcm_s16le",
        "-f", "wav",
        "-y", str(temporary_path.resolve()),
    ]
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError as exc:
        raise MediaProcessingError("ffmpeg_unavailable", "FFmpeg is not installed or is not on PATH.") from exc
    try:
        _, _stderr = await _communicate_with_timeout(process, timeout_seconds)
        if process.returncode != 0:
            raise MediaProcessingError("audio_extraction_failed", "FFmpeg could not extract the source audio.")
        if not temporary_path.is_file():
            raise MediaProcessingError("audio_extraction_failed", "FFmpeg did not produce an audio file.")
        size = temporary_path.stat().st_size
        if size < 44 or size > max_audio_bytes:
            raise MediaProcessingError("audio_output_limit_exceeded", "The extracted audio is empty or exceeds the configured size limit.")
        temporary_path.chmod(0o600)
        temporary_path.replace(audio_path)
        return size
    finally:
        temporary_path.unlink(missing_ok=True)
