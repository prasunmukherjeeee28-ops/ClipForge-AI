from __future__ import annotations

import json
import math
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
    _normalised_marker_counts,
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
    make_wav(audio, duration=3, loud_range=(1, 2))
    features = extract_audio_seconds(audio)
    assert len(features) == 3
    assert features[0].rms_dbfs < -100
    assert -12 < features[1].rms_dbfs < -5
    assert features[1].zero_crossing_rate > 0.9
    assert features[2].rms_dbfs < -100


def test_zero_crossing_texture_change_contributes_to_acoustic_salience(tmp_path: Path) -> None:
    audio = tmp_path / "texture.wav"
    transcript = tmp_path / "transcript.json"
    sample_rate = 16000
    samples = array("h")
    for second in range(30):
        if 10 <= second < 16:
            # Same RMS amplitude, but a much higher zero-crossing rate.
            samples.extend([12000 if index % 2 else -12000 for index in range(sample_rate)])
        else:
            # A 100 Hz square wave with the same amplitude.
            samples.extend([12000 if (index // 80) % 2 else -12000 for index in range(sample_rate)])
    with wave.open(str(audio), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(samples.tobytes())
    make_transcript(transcript, [
        {"start": 9, "end": 12, "text": "Wait what just happened"},
        {"start": 13, "end": 16, "text": "No way let's go"},
    ])

    candidates = detect_moments(
        audio, transcript, window_seconds=(15,), step_seconds=1, score_threshold=0
    )
    assert candidates
    assert max(item.acoustic_salience for item in candidates) > 0


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



def test_candidate_windows_never_extend_past_fractional_audio_duration(tmp_path: Path) -> None:
    audio = tmp_path / "fractional.wav"
    transcript = tmp_path / "transcript.json"
    sample_rate = 16000
    samples = array("h", [0] * int(sample_rate * 15.5))
    with wave.open(str(audio), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(samples.tobytes())
    make_transcript(transcript, [
        {"start": 1, "end": 3, "text": "Wait no way let's go"},
        {"start": 8, "end": 10, "text": "That was absolutely insane"},
    ])
    candidates = detect_moments(audio, transcript, window_seconds=(10,), step_seconds=1, score_threshold=0)
    assert candidates
    assert all(item.end_seconds <= 15.5 for item in candidates)



def test_reaction_markers_match_whole_phrases_not_substrings() -> None:
    assert _normalised_marker_counts("The whole lobby went quiet") == {}
    assert _normalised_marker_counts("No way! That was close.") == {
        "no way": 1,
        "that was close": 1,
    }


def test_short_speech_burst_scores_above_evenly_spread_speech(tmp_path: Path) -> None:
    audio = tmp_path / "audio.wav"
    clustered_transcript = tmp_path / "clustered.json"
    distributed_transcript = tmp_path / "distributed.json"
    make_wav(audio, duration=20, loud_range=None)

    words = ["we", "need", "to", "move", "right", "now", "come", "on", "go", "go", "go", "go"]
    clustered = [
        {"start": 5 + index * 0.3, "end": 5.2 + index * 0.3, "text": word}
        for index, word in enumerate(words)
    ]
    distributed = [
        {"start": 1 + index, "end": 1.2 + index, "text": word}
        for index, word in enumerate(words)
    ]
    make_transcript(clustered_transcript, [{
        "start": 5, "end": 9, "text": " ".join(words), "words": clustered,
    }])
    make_transcript(distributed_transcript, [{
        "start": 1, "end": 13, "text": " ".join(words), "words": distributed,
    }])

    clustered_result = detect_moments(
        audio, clustered_transcript, window_seconds=(15,), step_seconds=1, score_threshold=0,
    )
    distributed_result = detect_moments(
        audio, distributed_transcript, window_seconds=(15,), step_seconds=1, score_threshold=0,
    )
    assert clustered_result and distributed_result
    assert max(item.transcript_velocity for item in clustered_result) > max(
        item.transcript_velocity for item in distributed_result
    )



def test_spectral_flux_detects_a_new_sound_texture(tmp_path: Path) -> None:
    audio = tmp_path / "spectral-flux.wav"
    sample_rate = 16000
    samples = array("h", [0] * sample_rate)
    samples.extend(
        int(10000 * math.sin(2.0 * math.pi * 440.0 * index / sample_rate))
        for index in range(sample_rate)
    )
    samples.extend([0] * sample_rate)
    with wave.open(str(audio), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(sample_rate)
        output.writeframes(samples.tobytes())

    features = extract_audio_seconds(audio)
    assert len(features) == 3
    assert features[0].spectral_flux == 0.0
    assert features[1].spectral_flux > features[0].spectral_flux
    assert features[2].spectral_flux > features[0].spectral_flux
