from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from clipforge_processor.media import extract_audio, probe_media
from clipforge_processor.moments import detect_moments
from clipforge_processor.render import render_vertical_clip


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="real media pipeline smoke test requires FFmpeg and FFprobe",
)
def test_real_vod_audio_detection_and_vertical_render_pipeline(tmp_path: Path) -> None:
    """Exercise real FFmpeg binaries across source validation, audio, AI ranking and export."""
    source = tmp_path / "authorized-source.mp4"
    audio = tmp_path / "normalized-audio.wav"
    transcript = tmp_path / "transcript.json"
    output = tmp_path / "clip.mp4"

    generated = subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=24",
            "-f", "lavfi", "-i", "sine=frequency=880:sample_rate=48000",
            "-t", "22", "-c:v", "libx264", "-pix_fmt", "yuv420p",
            "-c:a", "aac", "-shortest", str(source),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=60,
    )
    assert generated.returncode == 0, generated.stderr[-1000:]

    source_probe = asyncio.run(probe_media(source))
    assert source_probe.width == 640
    assert source_probe.height == 360
    assert source_probe.duration_seconds >= 21

    asyncio.run(extract_audio(source, audio))
    assert audio.is_file() and audio.stat().st_size > 44

    # A deterministic transcript fixture isolates the media pipeline from
    # downloading model weights while still exercising the real moment detector.
    transcript.write_text(
        json.dumps({
            "segments": [
                {
                    "start": 0.5,
                    "end": 21.0,
                    "text": "We are moving through the city and this is getting wild no way let's go that was close",
                }
            ]
        }),
        encoding="utf-8",
    )
    candidates = detect_moments(
        audio,
        transcript,
        window_seconds=(10, 15),
        step_seconds=5,
        score_threshold=0.0,
        max_results=10,
    )
    assert candidates, "the detector should produce at least one candidate from the fixture"

    candidate = max(candidates, key=lambda item: item.score)
    rendered = render_vertical_clip(
        source,
        transcript,
        output,
        start_seconds=candidate.start_seconds,
        end_seconds=candidate.end_seconds,
        timeout_seconds=120,
    )
    assert output.is_file()
    assert rendered.width == 1080 and rendered.height == 1920
    assert rendered.size_bytes > 1024

    output_probe = asyncio.run(probe_media(output))
    assert (output_probe.width, output_probe.height) == (1080, 1920)
    assert output_probe.video_codec == "h264"
    assert output_probe.audio_codec == "aac"
    assert 5 <= output_probe.duration_seconds <= 120
