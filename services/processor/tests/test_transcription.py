from __future__ import annotations

from pathlib import Path
from types import SimpleNamespace

import pytest

from clipforge_processor.transcription import (
    TranscriptionError,
    chunk_windows,
    transcribe_audio,
)


def test_chunk_windows_have_bounded_overlaps_and_contiguous_centres() -> None:
    windows = list(chunk_windows(605, 300, 1))
    assert len(windows) == 3
    assert windows[0] == (0, 0, 300, 0, 301)
    assert windows[1] == (1, 300, 600, 299, 601)
    assert windows[2] == (2, 600, 605, 599, 605)


def test_chunk_windows_reject_unsupported_bounds() -> None:
    with pytest.raises(ValueError):
        list(chunk_windows(0, 300))
    with pytest.raises(ValueError):
        list(chunk_windows(300, 30))


def test_transcribe_audio_writes_absolute_segment_and_word_timestamps_and_resumes(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    audio.write_bytes(b"RIFF" + b"0" * 64)
    output = tmp_path / "transcription"
    calls: list[tuple[float, float]] = []

    class FakeModel:
        def transcribe(self, path: str, **kwargs):
            assert kwargs["word_timestamps"] is True
            assert kwargs["vad_filter"] is True
            segment = SimpleNamespace(
                start=2.0,
                end=4.0,
                text=" hello world",
                words=[
                    SimpleNamespace(start=2.0, end=2.5, word=" hello"),
                    SimpleNamespace(start=2.5, end=4.0, word=" world"),
                ],
            )
            return iter([segment]), SimpleNamespace(language="en", language_probability=0.99)

    def fake_extract(source, destination, *, start_seconds, duration_seconds, ffmpeg_binary):
        calls.append((start_seconds, duration_seconds))
        destination.write_bytes(b"RIFF" + b"chunk")

    result = transcribe_audio(
        audio,
        output,
        source_asset_id="asset-123",
        duration_seconds=605,
        model_name="base",
        model_cache_dir=tmp_path / "models",
        chunk_seconds=300,
        model_factory=lambda *args: FakeModel(),
        chunk_extractor=fake_extract,
    )

    assert result.model == "base"
    assert result.language == "en"
    assert result.segment_count == 3
    assert result.size_bytes > 2
    assert len(result.sha256) == 64
    assert calls == [(0, 301), (299, 302), (599, 6)]

    import json
    transcript = json.loads(result.transcript_path.read_text())
    assert len(transcript["segments"]) == 3
    assert transcript["segments"][0]["start"] == 2.0
    assert transcript["segments"][1]["start"] == 301.0
    assert transcript["segments"][2]["start"] == 601.0
    assert transcript["segments"][0]["words"][0]["start"] == 2.0

    # Completed local artifacts are reusable without loading the model again.
    cached = transcribe_audio(
        audio,
        output,
        source_asset_id="asset-123",
        duration_seconds=605,
        model_name="base",
        model_cache_dir=tmp_path / "models",
        chunk_seconds=300,
        model_factory=lambda *args: (_ for _ in ()).throw(AssertionError("model should not reload")),
        chunk_extractor=fake_extract,
    )
    assert cached.sha256 == result.sha256


def test_transcribe_audio_rejects_missing_audio(tmp_path: Path) -> None:
    with pytest.raises(TranscriptionError) as error:
        transcribe_audio(
            tmp_path / "missing.wav",
            tmp_path / "transcription",
            source_asset_id="asset-123",
            duration_seconds=60,
        )
    assert error.value.code == "audio_artifact_missing"
