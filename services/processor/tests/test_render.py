from __future__ import annotations

import json
import subprocess
from pathlib import Path

import pytest

from clipforge_processor.render import (
    ClipRenderError,
    _timestamp,
    render_vertical_clip,
)


def test_timestamp_formats_srt_milliseconds() -> None:
    assert _timestamp(3661.234) == "01:01:01,234"


def test_render_uses_safe_argument_array_and_preserves_full_frame(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "source.mp4"
    transcript = tmp_path / "transcript.json"
    output = tmp_path / "clips" / "clip.mp4"
    source.write_bytes(b"source")
    transcript.write_text(json.dumps({
        "segments": [
            {"start": 10.0, "end": 12.0, "text": "Wait, what just happened?"},
            {"start": 14.0, "end": 16.0, "text": "That was insane"},
            {"start": 40.0, "end": 42.0, "text": "Outside selected range"},
        ]
    }), encoding="utf-8")
    captured: dict[str, object] = {}

    def fake_run(command: list[str], **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured["command"] = command
        captured["kwargs"] = kwargs
        Path(command[-1]).write_bytes(b"x" * 2048)
        return subprocess.CompletedProcess(command, 0, "", "")

    monkeypatch.setattr("clipforge_processor.render.subprocess.run", fake_run)
    rendered = render_vertical_clip(
        source, transcript, output,
        start_seconds=10, end_seconds=30,
    )

    command = captured["command"]
    assert isinstance(command, list)
    assert "shell" not in captured["kwargs"]
    assert "-filter_complex" in command
    filter_graph = command[command.index("-filter_complex") + 1]
    assert "boxblur" in filter_graph
    assert "overlay=" in filter_graph
    assert "subtitles=filename=" in filter_graph
    assert rendered.width == 1080 and rendered.height == 1920
    assert rendered.duration_seconds == 20
    assert output.is_file() and output.stat().st_size == 2048


@pytest.mark.parametrize(
    ("start", "end"),
    [(-1, 10), (5, 5), (0, 121), (float("nan"), 20), (0, float("inf"))],
)
def test_rejects_invalid_clip_bounds(tmp_path: Path, start: float, end: float) -> None:
    source = tmp_path / "source.mp4"
    transcript = tmp_path / "transcript.json"
    source.write_bytes(b"source")
    transcript.write_text(json.dumps({"segments": []}), encoding="utf-8")
    with pytest.raises(ClipRenderError) as error:
        render_vertical_clip(source, transcript, tmp_path / "clip.mp4", start_seconds=start, end_seconds=end)
    assert error.value.code == "clip_bounds_invalid"


def test_rejects_invalid_transcript_before_running_ffmpeg(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "source.mp4"
    transcript = tmp_path / "transcript.json"
    source.write_bytes(b"source")
    transcript.write_text("{bad", encoding="utf-8")
    monkeypatch.setattr(
        "clipforge_processor.render.subprocess.run",
        lambda *args, **kwargs: pytest.fail("FFmpeg must not run with an invalid transcript"),
    )
    with pytest.raises(ClipRenderError) as error:
        render_vertical_clip(source, transcript, tmp_path / "clip.mp4", start_seconds=0, end_seconds=10)
    assert error.value.code == "transcript_artifact_invalid"


def test_timeout_is_reported_without_exposing_process_output(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "source.mp4"
    transcript = tmp_path / "transcript.json"
    source.write_bytes(b"source")
    transcript.write_text(json.dumps({"segments": []}), encoding="utf-8")

    def timeout(*args: object, **kwargs: object) -> None:
        raise subprocess.TimeoutExpired("ffmpeg", 10, stderr="private process output")

    monkeypatch.setattr("clipforge_processor.render.subprocess.run", timeout)
    with pytest.raises(ClipRenderError) as error:
        render_vertical_clip(source, transcript, tmp_path / "clip.mp4", start_seconds=0, end_seconds=10)
    assert error.value.code == "render_timeout"
    assert "private process output" not in str(error.value)
