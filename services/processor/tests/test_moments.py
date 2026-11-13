from __future__ import annotations

import json
import wave
from array import array
from pathlib import Path

import pytest

from clipforge_processor.moments import (
    MomentCandidate,
    MomentDetectionError,
    detect_moments,
    extract_audio_seconds,
    non_maximum_suppression,
)


def make_wav(path: Path, *, duration: int = 60, loud_range: tuple[int, int] | None = (20, 26)) -> None:
    sample_rate = 16000
    samples = array("h")
    for second in range(duration):
        amplitude = 12000 if loud_range and loud_range[0] <= second < loud_range[1] else 0
        samples.extend([amplitude if index % 2 else -amplitude for index in range(sample_rate)])
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(samples.tobytes())


def make_transcript(path: Path, segments: list[dict[str, object]]) -> None:
    path.write_text(json.dumps({"formatVersion": 1, "segments": segments}), encoding="utf-8")


def test_extract_audio_seconds_reports_rms_and_zero_crossings(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    make_wav(audio, duration=3)
    features = extract_audio_seconds(audio)
    assert len(features) == 3
    assert features[0].rms_dbfs < -100
    assert features[1].rms_dbfs < -100
    assert features[2].rms_dbfs < -100


def test_detect_moments_fuses_audio_and_transcript_and_returns_explanations(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    transcript = tmp_path / "transcript.json"
    make_wav(audio)
    make_transcript(transcript, [
        {
            "start": 18, "end": 20, "text": "Wait wait wait",
            "words": [
                {"start": 18.0, "end": 18.3, "text": "Wait"},
                {"start": 18.4, "end": 18.7, "text": "wait"},
                {"start": 19.0, "end": 19.3, "text": "wait"},
            ],
        },
        {
            "start": 21, "end": 23, "text": "No way let's go",
            "words": [
                {"start": 21.0, "end": 21.4, "text": "No"},
                {"start": 21.4, "end": 21.7, "text": "way"},
                {"start": 22.0, "end": 22.3, "text": "let's"},
                {"start": 22.3, "end": 22.6, "text": "go"},
            ],
        },
        {
            "start": 25, "end": 27, "text": "That was insane",
            "words": [
                {"start": 25.0, "end": 25.3, "text": "That"},
                {"start": 25.3, "end": 25.5, "text": "was"},
                {"start": 25.5, "end": 26.0, "text": "insane"},
            ],
        },
    ])

    candidates = detect_moments(audio, transcript, window_seconds=(15, 30), step_seconds=5)
    assert candidates
    best = max(candidates, key=lambda item: item.score)
    assert best.start_seconds <= 18
    assert best.end_seconds >= 27
    assert best.score > 0.42
    assert best.acoustic_salience > 0
    assert best.transcript_velocity > 0
    assert best.narrative_arc > 0
    assert best.novelty > 0
    assert best.rationale


def test_audio_only_spike_does_not_create_candidate(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    transcript = tmp_path / "transcript.json"
    make_wav(audio)
    make_transcript(transcript, [])
    assert detect_moments(audio, transcript, window_seconds=(15,), step_seconds=5) == []


def test_rejects_unsupported_audio_format(tmp_path: Path) -> None:
    audio = tmp_path / "stereo.wav"
    with wave.open(str(audio), "wb") as output:
        output.setnchannels(2)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(b"\x00" * 64000)
    with pytest.raises(MomentDetectionError) as error:
        extract_audio_seconds(audio)
    assert error.value.code == "audio_format_unsupported"


def test_rejects_invalid_transcript(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    transcript = tmp_path / "transcript.json"
    make_wav(audio)
    transcript.write_text("{bad", encoding="utf-8")
    with pytest.raises(MomentDetectionError) as error:
        detect_moments(audio, transcript, window_seconds=(15,), step_seconds=5)
    assert error.value.code == "transcript_artifact_invalid"


def candidate(start: float, end: float, score: float) -> MomentCandidate:
    return MomentCandidate(start, end, score, 0.5, 0.5, 0.5, 0.5, 20, 2, "test")


def test_nms_keeps_highest_scoring_overlapping_candidate_and_preserves_separate_one() -> None:
    kept = non_maximum_suppression([
        candidate(10, 40, 0.8),
        candidate(15, 45, 0.9),
        candidate(100, 130, 0.7),
    ])
    assert [(item.start_seconds, item.end_seconds) for item in kept] == [(15, 45), (100, 130)]
