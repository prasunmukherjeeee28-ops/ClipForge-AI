from __future__ import annotations

import asyncio
import json
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any


MAX_RENDER_DURATION_SECONDS = 120
MAX_SOURCE_TRANSCRIPT_BYTES = 100_000_000
MAX_CAPTION_EVENTS = 2500
MAX_OUTPUT_BYTES = 536_870_912
SUPPORTED_OUTPUTS = {
    "1080x1920": (1080, 1920),
    "720x1280": (720, 1280),
}


class ClipRenderError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class RenderResult:
    output_path: Path
    duration_seconds: float
    width: int
    height: int
    size_bytes: int
    title: str


def _ass_time(seconds: float) -> str:
    value = max(0.0, seconds)
    centiseconds = int(round(value * 100))
    hours, centiseconds = divmod(centiseconds, 360000)
    minutes, centiseconds = divmod(centiseconds, 6000)
    whole_seconds, centiseconds = divmod(centiseconds, 100)
    return f"{hours}:{minutes:02d}:{whole_seconds:02d}.{centiseconds:02d}"


def _ass_text(value: str) -> str:
    # Prevent transcript text from injecting ASS override tags or extra events.
    cleaned = "".join(char for char in value if char >= " " and char not in "\r\n\x7f")
    return cleaned.replace("\\", r"\\").replace("{", r"\{").replace("}", r"\}")


def _caption_groups(
    transcript: dict[str, Any],
    *,
    clip_start: float,
    clip_end: float,
) -> list[tuple[float, float, str]]:
    groups: list[tuple[float, float, str]] = []
    segments = transcript.get("segments")
    if not isinstance(segments, list):
        return groups

    words: list[tuple[float, float, str]] = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        raw_words = segment.get("words")
        if isinstance(raw_words, list) and raw_words:
            for word in raw_words:
                if not isinstance(word, dict) or not isinstance(word.get("text"), str):
                    continue
                try:
                    start = float(word.get("start"))
                    end = float(word.get("end"))
                except (TypeError, ValueError, OverflowError):
                    continue
                text = _ass_text(word["text"]).strip()
                if not text or not math.isfinite(start) or not math.isfinite(end) or end <= start:
                    continue
                if end <= clip_start or start >= clip_end:
                    continue
                words.append((max(start, clip_start), min(end, clip_end), text))
        elif isinstance(segment.get("text"), str):
            try:
                start = float(segment.get("start"))
                end = float(segment.get("end"))
            except (TypeError, ValueError, OverflowError):
                continue
            if not math.isfinite(start) or not math.isfinite(end) or end <= start:
                continue
            if end <= clip_start or start >= clip_end:
                continue
            phrase = _ass_text(segment["text"]).strip()
            if phrase:
                groups.append((max(start, clip_start), min(end, clip_end), phrase[:140]))

    words.sort(key=lambda item: item[0])
    current: list[tuple[float, float, str]] = []

    def flush() -> None:
        if not current:
            return
        text = " ".join(item[2] for item in current).strip()
        start = current[0][0]
        end = current[-1][1]
        if text and end > start:
            groups.append((start, end, text))
        current.clear()

    for word in words:
        if current and (
            len(current) >= 6
            or word[0] - current[-1][1] > 0.55
            or word[1] - current[0][0] > 3.2
        ):
            flush()
        current.append(word)
    flush()
    groups.sort(key=lambda item: item[0])
    return groups[:MAX_CAPTION_EVENTS]


def _write_ass_subtitles(
    transcript_path: Path,
    destination: Path,
    *,
    clip_start: float,
    clip_end: float,
    width: int,
    height: int,
) -> int:
    if transcript_path.is_symlink() or not transcript_path.is_file():
        raise ClipRenderError("transcript_artifact_missing", "The private transcript file is missing.")
    if transcript_path.stat().st_size > MAX_SOURCE_TRANSCRIPT_BYTES:
        raise ClipRenderError("transcript_artifact_invalid", "The transcript exceeds the supported size limit.")
    try:
        transcript = json.loads(transcript_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ClipRenderError("transcript_artifact_invalid", "The private transcript could not be read.") from exc
    if not isinstance(transcript, dict):
        raise ClipRenderError("transcript_artifact_invalid", "The private transcript has an invalid structure.")

    groups = _caption_groups(transcript, clip_start=clip_start, clip_end=clip_end)
    font_size = max(34, round(width * 0.052))
    margin_v = max(150, round(height * 0.105))
    content = [
        "[Script Info]",
        "ScriptType: v4.00+",
        f"PlayResX: {width}",
        f"PlayResY: {height}",
        "WrapStyle: 2",
        "ScaledBorderAndShadow: yes",
        "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: Default,Arial,{font_size},&H00FFFFFF,&H000000FF,&H00101010,&H99000000,1,0,0,0,100,100,0,0,1,4,1,2,64,64,{margin_v},1",
        "",
        "[Events]",
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for start, end, text in groups:
        relative_start = max(0.0, start - clip_start)
        relative_end = max(relative_start + 0.08, min(clip_end - clip_start, end - clip_start))
        if relative_end <= relative_start:
            continue
        content.append(
            f"Dialogue: 0,{_ass_time(relative_start)},{_ass_time(relative_end)},Default,,0,0,0,,{text}"
        )
    temporary = destination.with_name(destination.name + ".partial")
    temporary.unlink(missing_ok=True)
    temporary.write_text("\n".join(content) + "\n", encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(destination)
    return len(groups)


def _escape_filter_path(path: Path) -> str:
    value = str(path.resolve())
    return (
        value.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "\\'")
        .replace(",", "\\,")
        .replace("[", "\\[")
        .replace("]", "\\]")
    )


async def _run_process(command: list[str], timeout_seconds: float) -> tuple[int, bytes, bytes]:
    try:
        process = await asyncio.create_subprocess_exec(
            *command,
            stdin=asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.DEVNULL,
        )
    except FileNotFoundError as exc:
        raise ClipRenderError("ffmpeg_unavailable", "FFmpeg or FFprobe is not installed.") from exc
    try:
        stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=timeout_seconds)
        return process.returncode or 0, stdout, stderr
    except asyncio.TimeoutError as exc:
        if process.returncode is None:
            process.kill()
            await process.communicate()
        raise ClipRenderError("clip_render_timeout", "The clip rendering operation exceeded its time limit.") from exc
    except asyncio.CancelledError:
        if process.returncode is None:
            process.kill()
            await process.communicate()
        raise


async def _probe_output(
    output_path: Path,
    *,
    ffprobe_binary: str,
    timeout_seconds: float,
    expected_width: int,
    expected_height: int,
    expected_duration: float,
) -> None:
    command = [
        ffprobe_binary, "-v", "error",
        "-show_entries", "format=format_name,duration:stream=codec_type,codec_name,width,height",
        "-of", "json",
        str(output_path.resolve()),
    ]
    return_code, stdout, _ = await _run_process(command, timeout_seconds)
    if return_code != 0:
        raise ClipRenderError("clip_output_invalid", "FFprobe could not validate the rendered clip.")
    try:
        document = json.loads(stdout.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ClipRenderError("clip_output_invalid", "FFprobe returned invalid output metadata.") from exc
    streams = document.get("streams", []) if isinstance(document, dict) else []
    video = next((item for item in streams if isinstance(item, dict) and item.get("codec_type") == "video"), None)
    audio = next((item for item in streams if isinstance(item, dict) and item.get("codec_type") == "audio"), None)
    format_info = document.get("format", {}) if isinstance(document, dict) else {}
    try:
        duration = float(format_info.get("duration"))
    except (TypeError, ValueError, OverflowError):
        duration = 0.0
    if (
        not isinstance(video, dict) or not isinstance(audio, dict)
        or video.get("codec_name") != "h264"
        or video.get("width") != expected_width
        or video.get("height") != expected_height
        or audio.get("codec_name") != "aac"
        or not isinstance(format_info.get("format_name"), str)
        or "mp4" not in format_info["format_name"]
        or not math.isfinite(duration)
        or duration <= 0
        or duration > expected_duration + 1.5
    ):
        raise ClipRenderError("clip_output_invalid", "The output did not meet the required MP4 video/audio profile.")


async def render_clip(
    source_path: Path,
    transcript_path: Path,
    output_path: Path,
    *,
    start_seconds: float,
    end_seconds: float,
    captions: bool = True,
    resolution: str = "1080x1920",
    ffmpeg_binary: str = "ffmpeg",
    ffprobe_binary: str = "ffprobe",
    timeout_seconds: float = 900,
    threads: int = 2,
) -> RenderResult:
    """Render a full-frame 9:16 MP4, using a blurred background rather than cropping gameplay."""
    if resolution not in SUPPORTED_OUTPUTS:
        raise ClipRenderError("render_options_invalid", "The requested output resolution is unsupported.")
    width, height = SUPPORTED_OUTPUTS[resolution]
    duration = end_seconds - start_seconds
    if (
        not math.isfinite(start_seconds) or not math.isfinite(end_seconds)
        or start_seconds < 0 or duration < 10 or duration > MAX_RENDER_DURATION_SECONDS
    ):
        raise ClipRenderError("candidate_timestamps_invalid", "The candidate duration is outside the supported range.")
    if threads < 1 or threads > 4 or timeout_seconds < 10 or timeout_seconds > 3600:
        raise ClipRenderError("render_options_invalid", "The renderer resource limits are invalid.")
    if source_path.is_symlink() or not source_path.is_file() or source_path.stat().st_size < 1:
        raise ClipRenderError("render_source_missing", "The private source video is missing or invalid.")
    if transcript_path.is_symlink() or not transcript_path.is_file():
        raise ClipRenderError("transcript_artifact_missing", "The private transcript file is missing.")

    output_path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if output_path.parent.is_symlink() or output_path.is_symlink():
        raise ClipRenderError("render_storage_invalid", "The output directory must not be a symlink.")
    output_path.parent.chmod(0o700)
    temporary_output = output_path.with_name(output_path.stem + ".partial.mp4")
    temporary_output.unlink(missing_ok=True)
    subtitle_path = output_path.with_suffix(".ass")
    caption_count = 0

    filter_graph = (
        f"[0:v]split=2[bgsrc][fgsrc];"
        f"[bgsrc]scale={width}:{height}:force_original_aspect_ratio=increase,"
        f"crop={width}:{height},boxblur=24:12[bg];"
        f"[fgsrc]scale={width}:{round(height * 0.69)}:force_original_aspect_ratio=decrease,"
        f"format=rgba,pad={width}:{round(height * 0.69)}:(ow-iw)/2:(oh-ih)/2:color=black@0[fg];"
        f"[bg][fg]overlay=0:(H-h)/2,setsar=1[vbase]"
    )
    if captions:
        caption_count = _write_ass_subtitles(
            transcript_path,
            subtitle_path,
            clip_start=start_seconds,
            clip_end=end_seconds,
            width=width,
            height=height,
        )
        filter_graph += f";[vbase]ass='{_escape_filter_path(subtitle_path)}'[vout]"
    else:
        filter_graph += ";[vbase]null[vout]"

    command = [
        ffmpeg_binary,
        "-nostdin", "-hide_banner", "-loglevel", "error", "-xerror",
        "-protocol_whitelist", "file,pipe",
        "-ss", f"{start_seconds:.3f}",
        "-i", str(source_path.resolve()),
        "-t", f"{duration:.3f}",
        "-filter_complex", filter_graph,
        "-map", "[vout]",
        "-map", "0:a:0",
        "-sn", "-dn",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-pix_fmt", "yuv420p",
        "-threads", str(threads),
        "-c:a", "aac",
        "-b:a", "160k",
        "-movflags", "+faststart",
        "-fs", str(MAX_OUTPUT_BYTES),
        "-f", "mp4",
        "-y", str(temporary_output.resolve()),
    ]

    try:
        return_code, _, _ = await _run_process(command, timeout_seconds)
        if return_code != 0:
            raise ClipRenderError("clip_render_failed", "FFmpeg could not render the selected highlight.")
        if not temporary_output.is_file():
            raise ClipRenderError("clip_render_failed", "FFmpeg did not produce an output file.")
        size = temporary_output.stat().st_size
        if size < 1024 or size > MAX_OUTPUT_BYTES:
            raise ClipRenderError("clip_output_limit_exceeded", "The rendered MP4 is empty or exceeds the 512 MiB limit.")
        temporary_output.chmod(0o600)
        await _probe_output(
            temporary_output,
            ffprobe_binary=ffprobe_binary,
            timeout_seconds=min(60, timeout_seconds),
            expected_width=width,
            expected_height=height,
            expected_duration=duration,
        )
        temporary_output.replace(output_path)
        return RenderResult(
            output_path=output_path,
            duration_seconds=duration,
            width=width,
            height=height,
            size_bytes=size,
            title=f"Highlight {int(start_seconds // 60):02d}:{int(start_seconds % 60):02d}",
        )
    finally:
        temporary_output.unlink(missing_ok=True)
