from __future__ import annotations

import json
from pathlib import Path

import pytest

from clipforge_processor.render import (
    ClipRenderError,
    _caption_groups,
    _write_ass_subtitles,
    render_clip,
)


def test_caption_groups_use_absolute_word_timestamps_and_clip_bounds() -> None:
    transcript = {
        "segments": [
            {
                "start": 10,
                "end": 15,
                "text": "No way let's go",
                "words": [
                    {"start": 9.0, "end": 9.5, "text": "early"},
                    {"start": 10.2, "end": 10.5, "text": "No"},
                    {"start": 10.5, "end": 10.9, "text": "way"},
                    {"start": 11.0, "end": 11.4, "text": "let's"},
                    {"start": 11.4, "end": 11.8, "text": "go"},
                    {"start": 15.1, "end": 15.5, "text": "late"},
                ],
            }
        ]
    }
    groups = _caption_groups(transcript, clip_start=10, clip_end=15)
    assert len(groups) == 1
    assert groups[0][0] == 10.2
    assert groups[0][1] == 11.8
    assert groups[0][2] == "No way let's go"


def test_write_ass_subtitles_escapes_override_tags_and_sets_portrait_resolution(tmp_path: Path) -> None:
    transcript = tmp_path / "transcript.json"
    transcript.write_text(json.dumps({
        "segments": [{
            "start": 1, "end": 2, "text": "{\\an8}hello",
            "words": [{"start": 1, "end": 2, "text": "{\\an8}hello"}],
        }]
    }))
    output = tmp_path / "captions.ass"
    count = _write_ass_subtitles(
        transcript, output, clip_start=0, clip_end=5, width=1080, height=1920
    )
    text = output.read_text()
    assert count == 1
    assert "PlayResX: 1080" in text
    assert "PlayResY: 1920" in text
    assert r"\{\\an8\}hello" in text
    assert output.stat().st_mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_render_clip_builds_full_frame_portrait_mp4_without_trimming_gameplay(
    tmp_path: Path, monkeypatch
) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"private video bytes")
    transcript = tmp_path / "transcript.json"
    transcript.write_text(json.dumps({
        "segments": [{
            "start": 12, "end": 16, "text": "Wait no way let's go",
            "words": [
                {"start": 12.0, "end": 12.3, "text": "Wait"},
                {"start": 12.3, "end": 12.6, "text": "no"},
                {"start": 13.0, "end": 13.3, "text": "way"},
                {"start": 13.4, "end": 14.0, "text": "let's"},
                {"start": 14.0, "end": 14.4, "text": "go"},
            ],
        }]
    }))
    output = tmp_path / "private" / "clip.mp4"
    calls: list[list[str]] = []

    async def fake_run(command: list[str], timeout_seconds: float):
        calls.append(command)
        if command[0] == "ffmpeg":
            Path(command[-1]).write_bytes(b"0" * 4096)
            return 0, b"", b""
        return 0, json.dumps({
            "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "10.0"},
            "streams": [
                {"codec_type": "video", "codec_name": "h264", "width": 1080, "height": 1920},
                {"codec_type": "audio", "codec_name": "aac"},
            ],
        }).encode(), b""

    monkeypatch.setattr("clipforge_processor.render._run_process", fake_run)
    result = await render_clip(
        source, transcript, output,
        start_seconds=10, end_seconds=20,
        captions=True,
        resolution="1080x1920",
    )
    ffmpeg = calls[0]
    assert result.width == 1080 and result.height == 1920
    assert result.size_bytes == 4096
    assert output.exists()
    assert "-filter_complex" in ffmpeg
    graph = ffmpeg[ffmpeg.index("-filter_complex") + 1]
    # The foreground is fitted and padded; the crop/blur is only the background.
    assert "force_original_aspect_ratio=decrease" in graph
    assert "overlay=0:(H-h)/2" in graph
    assert "ass=" in graph
    assert "-c:v" in ffmpeg and "libx264" in ffmpeg
    assert "-c:a" in ffmpeg and "aac" in ffmpeg
    assert "1080:1920" in graph
    assert output.stat().st_mode & 0o777 == 0o600


@pytest.mark.asyncio
async def test_render_clip_rejects_invalid_clip_duration_before_running_ffmpeg(tmp_path: Path) -> None:
    source = tmp_path / "source.mp4"
    source.write_bytes(b"src")
    transcript = tmp_path / "transcript.json"
    transcript.write_text('{"segments":[]}')
    with pytest.raises(ClipRenderError) as error:
        await render_clip(
            source, transcript, tmp_path / "out.mp4",
            start_seconds=0, end_seconds=5,
        )
    assert error.value.code == "candidate_timestamps_invalid"


@pytest.mark.asyncio
async def test_render_clip_rejects_missing_source(tmp_path: Path) -> None:
    transcript = tmp_path / "transcript.json"
    transcript.write_text('{"segments":[]}')
    with pytest.raises(ClipRenderError) as error:
        await render_clip(
            tmp_path / "missing.mp4", transcript, tmp_path / "out.mp4",
            start_seconds=0, end_seconds=10,
        )
    assert error.value.code == "render_source_missing"
