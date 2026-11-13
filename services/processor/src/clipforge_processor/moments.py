from __future__ import annotations

import json
import math
import re
import statistics
import wave

import numpy as np
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterable


MAX_TRANSCRIPT_BYTES = 100_000_000
MAX_CANDIDATES = 100_000
DEFAULT_WINDOW_SECONDS = (15, 30, 45, 60, 90)
DEFAULT_STEP_SECONDS = 5
HIGHLIGHT_MARKERS = (
    "no way", "let's go", "lets go", "oh my god", "what just happened",
    "watch out", "he's right there", "hes right there", "clip that",
    "that was close", "are you serious", "holy", "insane", "unbelievable",
    "i'm dead", "im dead", "help me", "run", "bro",
)
_WORD_RE = re.compile(r"[a-z0-9']+")


class MomentDetectionError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class AudioSecond:
    second: int
    rms_dbfs: float
    zero_crossing_rate: float


@dataclass(frozen=True)
class MomentCandidate:
    start_seconds: float
    end_seconds: float
    score: float
    acoustic_salience: float
    transcript_velocity: float
    narrative_arc: float
    novelty: float
    word_count: int
    marker_count: int
    rationale: str

    def as_dict(self) -> dict[str, Any]:
        return {
            "startSeconds": round(self.start_seconds, 3),
            "endSeconds": round(self.end_seconds, 3),
            "score": round(self.score, 4),
            "signals": {
                "acousticSalience": round(self.acoustic_salience, 4),
                "transcriptVelocity": round(self.transcript_velocity, 4),
                "narrativeArc": round(self.narrative_arc, 4),
                "novelty": round(self.novelty, 4),
            },
            "wordCount": self.word_count,
            "markerCount": self.marker_count,
            "rationale": self.rationale,
        }


def extract_audio_seconds(
    wav_path: Path,
    *,
    expected_sample_rate: int = 16000,
    max_duration_seconds: int = 43200,
) -> list[AudioSecond]:
    """Read normalized mono PCM16 WAV and calculate one-second RMS/ZCR features."""
    if wav_path.is_symlink() or not wav_path.is_file():
        raise MomentDetectionError("audio_artifact_missing", "The normalized audio artifact is unavailable.")
    try:
        with wave.open(str(wav_path), "rb") as source:
            if (
                source.getnchannels() != 1
                or source.getsampwidth() != 2
                or source.getframerate() != expected_sample_rate
                or source.getcomptype() != "NONE"
            ):
                raise MomentDetectionError(
                    "audio_format_unsupported",
                    "Moment analysis requires uncompressed mono 16-bit PCM at 16 kHz.",
                )
            frames_per_second = source.getframerate()
            duration = source.getnframes() / frames_per_second
            if duration <= 0 or duration > max_duration_seconds:
                raise MomentDetectionError("audio_duration_unsupported", "The audio duration is outside supported limits.")
            output: list[AudioSecond] = []
            second = 0
            while True:
                raw = source.readframes(frames_per_second)
                if not raw:
                    break
                sample_count = len(raw) // 2
                if sample_count == 0:
                    break
                samples = np.frombuffer(raw, dtype="<i2")
                floating = samples.astype(np.float32, copy=False)
                rms = float(np.sqrt(np.mean(floating * floating, dtype=np.float64))) / 32768.0
                dbfs = 20.0 * math.log10(max(rms, 1e-8))
                zcr = float(np.count_nonzero(np.signbit(samples[1:]) != np.signbit(samples[:-1]))) / max(1, sample_count - 1)
                output.append(AudioSecond(second, dbfs, zcr))
                second += 1
            return output
    except (wave.Error, EOFError, OSError) as exc:
        raise MomentDetectionError("audio_artifact_invalid", "The normalized WAV could not be read.") from exc


def _load_transcript(path: Path, duration: float) -> list[dict[str, Any]]:
    if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_TRANSCRIPT_BYTES:
        raise MomentDetectionError("transcript_artifact_invalid", "The timestamped transcript is missing or exceeds its size limit.")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise MomentDetectionError("transcript_artifact_invalid", "The timestamped transcript is not valid JSON.") from exc
    segments = payload.get("segments") if isinstance(payload, dict) else None
    if not isinstance(segments, list) or len(segments) > 500_000:
        raise MomentDetectionError("transcript_artifact_invalid", "The transcript segment list is invalid.")
    output: list[dict[str, Any]] = []
    for segment in segments:
        if not isinstance(segment, dict):
            continue
        try:
            start = float(segment.get("start"))
            end = float(segment.get("end"))
        except (TypeError, ValueError, OverflowError):
            continue
        text = segment.get("text")
        if (
            not math.isfinite(start) or not math.isfinite(end) or end <= start
            or not isinstance(text, str) or not text.strip()
        ):
            continue
        start = max(0.0, min(duration, start))
        end = max(start, min(duration, end))
        if end <= start:
            continue
        words: list[dict[str, Any]] = []
        raw_words = segment.get("words")
        if isinstance(raw_words, list):
            for word in raw_words:
                if not isinstance(word, dict) or not isinstance(word.get("text"), str):
                    continue
                try:
                    word_start = float(word.get("start"))
                    word_end = float(word.get("end"))
                except (TypeError, ValueError, OverflowError):
                    continue
                if (
                    math.isfinite(word_start) and math.isfinite(word_end)
                    and end > start and word_end > word_start
                ):
                    words.append({
                        "start": max(start, min(end, word_start)),
                        "end": max(start, min(end, word_end)),
                        "text": word["text"][:100],
                    })
        output.append({"start": start, "end": end, "text": text[:2000], "words": words})
    return output


def _prefix(values: list[float]) -> list[float]:
    result = [0.0]
    for value in values:
        result.append(result[-1] + value)
    return result


def _range_sum(prefix: list[float], start: int, end: int) -> float:
    start = max(0, min(len(prefix) - 1, start))
    end = max(start, min(len(prefix) - 1, end))
    return prefix[end] - prefix[start]


def _normalised_marker_counts(text: str) -> Counter[str]:
    lowered = " ".join(_WORD_RE.findall(text.lower()))
    return Counter({marker: lowered.count(marker) for marker in HIGHLIGHT_MARKERS if marker in lowered})


def _iou(left: MomentCandidate, right: MomentCandidate) -> float:
    intersection = max(0.0, min(left.end_seconds, right.end_seconds) - max(left.start_seconds, right.start_seconds))
    union = max(left.end_seconds, right.end_seconds) - min(left.start_seconds, right.start_seconds)
    return intersection / union if union > 0 else 0.0


def non_maximum_suppression(
    candidates: Iterable[MomentCandidate],
    *,
    iou_threshold: float = 0.45,
    max_results: int = 100,
) -> list[MomentCandidate]:
    if not 0 < iou_threshold <= 1 or max_results < 1:
        raise ValueError("NMS bounds are invalid")
    ranked = sorted(candidates, key=lambda item: (-item.score, item.start_seconds, item.end_seconds))
    kept: list[MomentCandidate] = []
    for candidate in ranked:
        if all(_iou(candidate, previous) < iou_threshold for previous in kept):
            kept.append(candidate)
            if len(kept) >= max_results:
                break
    return sorted(kept, key=lambda item: item.start_seconds)


def detect_moments(
    audio_path: Path,
    transcript_path: Path,
    *,
    window_seconds: tuple[int, ...] = DEFAULT_WINDOW_SECONDS,
    step_seconds: int = DEFAULT_STEP_SECONDS,
    score_threshold: float = 0.42,
    max_results: int = 100,
) -> list[MomentCandidate]:
    """Generate explainable multi-scale candidates from local audio and transcript features.

    This is deterministic Tier 1/2 filtering, not an LLM judgment or a claim that
    a candidate is objectively entertaining. It deliberately requires speech context
    so isolated game-volume spikes do not dominate the shortlist.
    """
    if not window_seconds or any(value < 10 or value > 120 for value in window_seconds):
        raise ValueError("window lengths must be between 10 and 120 seconds")
    if step_seconds < 1 or step_seconds > 30 or not 0 <= score_threshold <= 1:
        raise ValueError("candidate scan settings are invalid")
    if max_results < 1 or max_results > 1000:
        raise ValueError("max_results must be between 1 and 1000")

    audio = extract_audio_seconds(audio_path)
    duration_bins = len(audio)
    if duration_bins == 0:
        return []
    try:
        with wave.open(str(audio_path), "rb") as source:
            duration = source.getnframes() / float(source.getframerate())
    except (wave.Error, EOFError, OSError) as exc:
        raise MomentDetectionError("audio_artifact_invalid", "The normalized WAV duration could not be read.") from exc
    if not math.isfinite(duration) or duration <= 0:
        raise MomentDetectionError("audio_duration_unsupported", "The audio duration is invalid.")
    segments = _load_transcript(transcript_path, duration)

    words_by_second = [0.0] * duration_bins
    marker_by_second = [0.0] * duration_bins
    speech_by_second = [0.0] * duration_bins
    all_markers: Counter[str] = Counter()
    marker_events: list[tuple[float, str, int]] = []
    for segment in segments:
        text = segment["text"]
        words = segment["words"]
        if words:
            for word in words:
                second = min(duration_bins - 1, max(0, int(word["start"])))
                words_by_second[second] += 1.0
                speech_by_second[second] = 1.0
        else:
            count = max(1, len(_WORD_RE.findall(text)))
            midpoint = (segment["start"] + segment["end"]) / 2
            second = min(duration_bins - 1, max(0, int(midpoint)))
            words_by_second[second] += float(count)
            for index in range(max(0, int(segment["start"])), min(duration_bins, math.ceil(segment["end"]))):
                speech_by_second[index] = 1.0
        markers = _normalised_marker_counts(text)
        if markers:
            all_markers.update(markers)
            for marker, count in markers.items():
                midpoint = (segment["start"] + segment["end"]) / 2
                second = min(duration_bins - 1, max(0, int(midpoint)))
                marker_by_second[second] += count
                marker_events.append((midpoint, marker, count))

    words_prefix = _prefix(words_by_second)
    marker_prefix = _prefix(marker_by_second)
    speech_prefix = _prefix(speech_by_second)
    novelty_by_second = [0.0] * duration_bins
    for timestamp, marker, count in marker_events:
        second = min(duration_bins - 1, max(0, int(timestamp)))
        novelty_by_second[second] += count / math.sqrt(1.0 + all_markers[marker])
    novelty_prefix = _prefix(novelty_by_second)
    # Use robust per-file baselines so a consistently loud game mix does not
    # dominate. RMS catches level changes; ZCR adds a bounded texture/transient
    # cue when sound character changes without a large volume increase.
    energy = [item.rms_dbfs for item in audio]
    energy_baseline = statistics.median(energy)
    energy_mad = statistics.median(abs(value - energy_baseline) for value in energy) or 1.0
    rms_spikes = [
        max(0.0, min(1.0, (value - energy_baseline - 2.0) / max(6.0, energy_mad * 4.0)))
        for value in energy
    ]
    zero_crossings = [item.zero_crossing_rate for item in audio]
    zcr_baseline = statistics.median(zero_crossings)
    zcr_mad = statistics.median(abs(value - zcr_baseline) for value in zero_crossings) or 0.01
    zcr_spikes = [
        max(0.0, min(1.0, (value - zcr_baseline - max(0.01, zcr_mad * 2.0)) / max(0.05, zcr_mad * 4.0)))
        for value in zero_crossings
    ]
    audio_spikes = [
        0.75 * rms_spike + 0.25 * zcr_spike
        for rms_spike, zcr_spike in zip(rms_spikes, zcr_spikes, strict=True)
    ]
    spike_prefix = _prefix(audio_spikes)

    candidates: list[MomentCandidate] = []
    for length in sorted(set(window_seconds)):
        if length > duration:
            continue
        last_start = math.floor(duration - length)
        for start in range(0, last_start + 1, step_seconds):
            end = min(float(start + length), duration)
            end_index = min(duration_bins, math.ceil(end))
            word_count = int(_range_sum(words_prefix, start, end_index))
            marker_count = int(_range_sum(marker_prefix, start, end_index))
            speech_seconds = _range_sum(speech_prefix, start, end_index)
            speech_rate = word_count / float(length)
            if word_count < 3 or speech_seconds < 1:
                continue

            average_spike = _range_sum(spike_prefix, start, end_index) / length
            peak_spike = max(audio_spikes[start:end_index], default=0.0)
            acoustic = min(1.0, 0.65 * peak_spike + 0.35 * min(1.0, average_spike * 4.0))

            velocity = min(1.0, speech_rate / 2.5)
            marker_density = min(1.0, marker_count / 2.0)
            transcript_velocity = 0.7 * velocity + 0.3 * marker_density

            third = max(1, length // 3)
            first_speech = _range_sum(speech_prefix, start, min(end_index, start + third))
            middle_spikes = max(audio_spikes[start + third:min(end_index, start + 2 * third)], default=0.0)
            last_speech = _range_sum(speech_prefix, min(end_index, start + 2 * third), end_index)
            coverage = (float(first_speech > 0) + float(last_speech > 0)) / 2.0
            peak_alignment = min(1.0, middle_spikes + marker_density * 0.5)
            narrative = 0.65 * coverage + 0.35 * peak_alignment

            if marker_count:
                rarity = _range_sum(novelty_prefix, start, end_index)
                novelty = min(1.0, rarity / max(1.0, marker_count))
            else:
                novelty = 0.0

            score = (
                0.25 * acoustic
                + 0.25 * transcript_velocity
                + 0.30 * narrative
                + 0.20 * novelty
            )
            if score < score_threshold:
                continue
            signals = []
            if acoustic >= 0.55:
                signals.append("audio energy change")
            if transcript_velocity >= 0.55:
                signals.append("high speech/marker activity")
            if narrative >= 0.55:
                signals.append("context on both sides of a peak")
            if novelty >= 0.45:
                signals.append("uncommon reaction phrase")
            rationale = ", ".join(signals) if signals else "combined transcript and audio cues"
            candidates.append(MomentCandidate(
                float(start), float(end), score, acoustic, transcript_velocity,
                narrative, novelty, word_count, marker_count, rationale,
            ))
            if len(candidates) > MAX_CANDIDATES:
                raise MomentDetectionError("candidate_limit_exceeded", "The candidate scan exceeded its configured safety limit.")

    return non_maximum_suppression(candidates, max_results=max_results)
