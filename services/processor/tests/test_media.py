from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

import pytest

from clipforge_processor.media import (
    MediaProcessingError,
    extract_audio,
    parse_probe_output,
    probe_media,
)


def valid_probe() -> dict[str, object]:
    return {
        "format": {"format_name": "mov,mp4,m4a,3gp,3g2,mj2", "duration": "125.5"},
        "streams": [
            {
                "codec_type": "video", "codec_name": "h264",
                "width": 1920, "height": 1080, "duration": "125.5",
            },
            {
                "codec_type": "audio", "codec_name": "aac",
                "sample_rate": "48000", "channels": 2, "duration": "125.4",
            },
        ],
    }


def test_parse_probe_output_extracts_bounded_media_metadata() -> None:
    result = parse_probe_output(json.dumps(valid_probe()))
    assert result.container.startswith("mov")
    assert result.duration_seconds == 125.5
    assert result.video_codec == "h264"
    assert result.audio_codec == "aac"
    assert (result.width, result.height) == (1920, 1080)
    assert (result.source_sample_rate, result.source_channels) == (48000, 2)


@pytest.mark.parametrize(
    ("mutation", "expected_code"),
    [
        (lambda d: d.update({"streams": []}), "media_missing_video"),
        (lambda d: d.update({"streams": [{"codec_type": "video", "codec_name": "h264", "width": 640, "height": 480}]}), "media_missing_audio"),
        (lambda d: d["format"].update({"duration": "43201"}), "media_duration_unsupported"),
        (lambda d: d["streams"][0].update({"width": 9000}), "media_dimensions_unsupported"),
    ],
)
def test_parse_probe_output_rejects_unsupported_media(mutation, expected_code: str) -> None:
    payload = valid_probe()
    mutation(payload)
    with pytest.raises(MediaProcessingError) as caught:
        parse_probe_output(json.dumps(payload))
    assert caught.value.code == expected_code


def test_parse_probe_output_rejects_malformed_json() -> None:
    with pytest.raises(MediaProcessingError) as caught:
        parse_probe_output("{not-json")
    assert caught.value.code == "invalid_media_probe"


@pytest.mark.asyncio
async def test_probe_media_invokes_ffprobe_without_a_shell(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source.upload"
    source.write_bytes(b"not-a-real-video-but-probe-is-mocked")
    calls: list[tuple[object, ...]] = []

    class FakeProcess:
        returncode = 0

        async def communicate(self):
            return json.dumps(valid_probe()).encode(), b""

    async def fake_exec(*args, **kwargs):
        calls.append(args)
        assert "shell" not in kwargs
        return FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    result = await probe_media(source)
    assert result.video_codec == "h264"
    assert calls[0][0] == "ffprobe"
    assert "-protocol_whitelist" in calls[0]
    assert str(source.resolve()) == calls[0][-1]


@pytest.mark.asyncio
async def test_extract_audio_writes_normalized_private_wav(tmp_path: Path, monkeypatch) -> None:
    source = tmp_path / "source.upload"
    source.write_bytes(b"source")
    output = tmp_path / "private" / "audio.wav"
    calls: list[tuple[object, ...]] = []

    class FakeProcess:
        returncode = 0

        async def communicate(self):
            Path(calls[0][-1]).write_bytes(b"RIFF" + b"\x00" * 60)
            return b"", b""

    async def fake_exec(*args, **kwargs):
        calls.append(args)
        assert "shell" not in kwargs
        return FakeProcess()

    monkeypatch.setattr(asyncio, "create_subprocess_exec", fake_exec)
    size = await extract_audio(source, output)
    assert size == 64
    assert output.read_bytes().startswith(b"RIFF")
    assert output.stat().st_mode & 0o777 == 0o600
    assert "-map" in calls[0] and "0:a:0" in calls[0]
    assert "-ac" in calls[0] and "1" in calls[0]
    assert "-ar" in calls[0] and "16000" in calls[0]
    assert "-c:a" in calls[0] and "pcm_s16le" in calls[0]
    assert "-fs" in calls[0] and str(1_500_000_000) in calls[0]
    assert not output.with_name("audio.wav.partial").exists()
