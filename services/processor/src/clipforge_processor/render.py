from __future__ import annotations

import json
import math
import re
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MAX_TRANSCRIPT_BYTES = 100_000_000
MAX_TRANSCRIPT_SEGMENTS = 500_000
DEFAULT_MAX_OUTPUT_BYTES = 500_000_000


class ClipRenderError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class RenderedClip:
    output_path: Path
    duration_seconds: float
    size_bytes: int
    width: int = 1080
    height: int = 1920
    aspect_ratio: str = "9:16"


def _timestamp(seconds: float) -> str:
    milliseconds = max(0, int(round(seconds * 1000)))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, millis = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{whole_seconds:02d},{millis:03d}"


def _safe_caption_text(value: str) -> str:
    # Keep captions plain text: strip control characters and markup delimiters.
    cleaned = re.sub(r"[\x00-\x1f\x7f]", " ", value)
    cleaned = cleaned.replace("<", "").replace(">", "").replace("{", "").replace("}", "")
    return " ".join(cleaned.split())[:500]


def _write_srt(transcript_path: Path, destination: Path, clip_start: float, clip_end: float) -> int:
    if transcript_path.is_symlink() or not transcript_path.is_file():
        raise ClipRenderError("transcript_artifact_missing", "The timestamped transcript is unavailable.")
    if transcript_path.stat().st_size > MAX_TRANSCRIPT_BYTES:
        raise ClipRenderError("transcript_artifact_invalid", "The transcript exceeds its configured size limit.")
    try:
        payload = json.loads(transcript_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ClipRenderError("transcript_artifact_invalid", "The timestamped transcript is invalid.") from exc
    segments = payload.get("segments") if isinstance(payload, dict) else None
    if not isinstance(segments, list) or len(segments) > MAX_TRANSCRIPT_SEGMENTS:
        raise ClipRenderError("transcript_artifact_invalid", "The transcript segment list is invalid.")

    entries: list[str] = []
    for segment in segments:
        if not isinstance(segment, dict) or not isinstance(segment.get("text"), str):
            continue
        try:
            start = float(segment.get("start"))
            end = float(segment.get("end"))
        except (TypeError, ValueError, OverflowError):
            continue
        if not math.isfinite(start) or not math.isfinite(end) or end <= start:
            continue
        left = max(clip_start, start)
        right = min(clip_end, end)
        text = _safe_caption_text(segment["text"])
        if right <= left or not text:
            continue
        # Wrap long transcript segments without changing their original timing.
        words = text.split()
        lines: list[str] = []
        current = ""
        for word in words:
            proposed = f"{current} {word}".strip()
            if len(proposed) > 42 and current:
                lines.append(current)
                current = word
            else:
                current = proposed
        if current:
            lines.append(current)
        entries.append(
            f"{len(entries) + 1}\n"
            f"{_timestamp(left - clip_start)} --> {_timestamp(right - clip_start)}\n"
            + "\n".join(lines[:2])
        )

    destination.write_text("\n\n".join(entries) + ("\n" if entries else ""), encoding="utf-8")
    destination.chmod(0o600)
    return len(entries)


def _filter_path(path: Path) -> str:
    value = path.resolve().as_posix()
    for character in ("\\", ":", "'", ",", "[", "]"):
        value = value.replace(character, "\\" + character)
    return value


def render_vertical_clip(
    source_path: Path,
    transcript_path: Path,
    output_path: Path,
    *,
    start_seconds: float,
    end_seconds: float,
    ffmpeg_binary: str = "ffmpeg",
    timeout_seconds: float = 900,
    max_output_bytes: int = DEFAULT_MAX_OUTPUT_BYTES,
    threads: int = 2,
) -> RenderedClip:
    """Render a bounded 1080x1920 MP4 with full-frame gameplay and synchronized captions.

    Landscape footage is contained over a blurred, cropped background rather than
    center-cropped, preserving the entire gameplay frame and HUD in the foreground.
    """
    source_path = Path(source_path)
    transcript_path = Path(transcript_path)
    output_path = Path(output_path)
    if source_path.is_symlink() or not source_path.is_file() or source_path.stat().st_size < 1:
        raise ClipRenderError("source_media_missing", "The validated source media is unavailable.")
    if not math.isfinite(start_seconds) or not math.isfinite(end_seconds):
        raise ClipRenderError("clip_bounds_invalid", "The selected clip boundaries are invalid.")
    duration = end_seconds - start_seconds
    if start_seconds < 0 or duration < 5 or duration > 120:
        raise ClipRenderError("clip_bounds_invalid", "Clip duration must be between 5 and 120 seconds.")
    if not ffmpeg_binary or len(ffmpeg_binary) > 200:
        raise ClipRenderError("render_config_invalid", "The FFmpeg executable setting is invalid.")
    if timeout_seconds < 1 or timeout_seconds > 3600 or max_output_bytes < 1_000_000 or max_output_bytes > 2_000_000_000:
        raise ClipRenderError("render_config_invalid", "Render resource limits are outside supported bounds.")
    if threads < 1 or threads > 4:
        raise ClipRenderError("render_config_invalid", "FFmpeg thread count must be between 1 and 4.")
    if output_path.suffix.lower() != ".mp4" or output_path.resolve() == source_path.resolve():
        raise ClipRenderError("render_output_invalid", "The output must be a separate MP4 file.")
    output_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if output_path.parent.is_symlink():
        raise ClipRenderError("render_output_invalid", "The output directory must not be a symlink.")
    output_path.parent.chmod(0o700)

    with tempfile.TemporaryDirectory(prefix=".clipforge-render-", dir=output_path.parent) as temporary:
        temporary_dir = Path(temporary)
        captions_path = temporary_dir / "captions.srt"
        partial_output = temporary_dir / "render.partial.mp4"
        caption_count = _write_srt(transcript_path, captions_path, start_seconds, end_seconds)
        subtitles_filter = (
            f"subtitles=filename='{_filter_path(captions_path)}':"
            "force_style='FontName=Arial,FontSize=18,Outline=2,Shadow=1,Alignment=2,MarginV=180'"
        )
        filter_complex = (
            "[0:v]split=2[background][foreground];"
            "[background]scale=1080:1920:force_original_aspect_ratio=increase,"
            "crop=1080:1920,boxblur=24:12[bg];"
            "[foreground]scale=1080:1920:force_original_aspect_ratio=decrease[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1,fps=30,{subtitles_filter}[v]"
        )
        command = [
            ffmpeg_binary, "-hide_banner", "-nostdin", "-y",
            "-i", str(source_path),
            "-ss", f"{start_seconds:.3f}",
            "-t", f"{duration:.3f}",
            "-filter_complex", filter_complex,
            "-map", "[v]", "-map", "0:a?",
            "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
            "-pix_fmt", "yuv420p", "-r", "30",
            "-c:a", "aac", "-b:a", "160k", "-af", "aresample=async=1:first_pts=0",
            "-movflags", "+faststart", "-threads", str(threads),
            "-fs", str(max_output_bytes), str(partial_output),
        ]
        try:
            result = subprocess.run(
                command,
                check=False,
                capture_output=True,
                text=True,
                timeout=timeout_seconds,
            )
        except subprocess.TimeoutExpired as exc:
            raise ClipRenderError("render_timeout", "Clip rendering exceeded its time limit.") from exc
        except OSError as exc:
            raise ClipRenderError("ffmpeg_unavailable", "The FFmpeg executable could not be started.") from exc
        if result.returncode != 0:
            raise ClipRenderError("clip_render_failed", "FFmpeg could not render the selected clip.")
        if not partial_output.is_file() or partial_output.stat().st_size < 1024:
            raise ClipRenderError("clip_render_empty", "FFmpeg did not produce a valid output file.")
        size_bytes = partial_output.stat().st_size
        if size_bytes > max_output_bytes:
            raise ClipRenderError("clip_output_too_large", "The rendered clip exceeds its configured size limit.")
        partial_output.replace(output_path)

    output_path.chmod(0o600)
    return RenderedClip(
        output_path=output_path,
        duration_seconds=duration,
        size_bytes=output_path.stat().st_size,
    )
