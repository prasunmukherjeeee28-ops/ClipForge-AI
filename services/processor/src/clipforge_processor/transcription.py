from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import subprocess
from collections import Counter
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable


TRANSCRIPT_FORMAT_VERSION = 1
MAX_TRANSCRIPT_BYTES = 100_000_000
MAX_SEGMENTS = 500_000
SUPPORTED_MODELS = {
    "tiny", "base", "small", "medium", "large-v3",
    "large-v3-turbo", "distil-large-v3",
}


class TranscriptionError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class TranscriptionResult:
    transcript_path: Path
    model: str
    language: str | None
    segment_count: int
    size_bytes: int
    sha256: str


def chunk_windows(duration_seconds: float, chunk_seconds: int, overlap_seconds: float = 1.0):
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ValueError("duration_seconds must be finite and positive")
    if chunk_seconds < 60 or chunk_seconds > 900:
        raise ValueError("chunk_seconds must be between 60 and 900")
    if overlap_seconds < 0 or overlap_seconds > 5:
        raise ValueError("overlap_seconds must be between 0 and 5")

    count = math.ceil(duration_seconds / chunk_seconds)
    for index in range(count):
        central_start = index * chunk_seconds
        central_end = min(duration_seconds, (index + 1) * chunk_seconds)
        extract_start = max(0.0, central_start - overlap_seconds)
        extract_end = min(duration_seconds, central_end + overlap_seconds)
        yield index, central_start, central_end, extract_start, extract_end


def _atomic_json(path: Path, payload: dict[str, Any]) -> None:
    temporary = path.with_name(path.name + ".partial")
    temporary.unlink(missing_ok=True)
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(path)


def _safe_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError, OverflowError):
        return None
    return number if math.isfinite(number) else None


def _make_model(model_name: str, cache_dir: Path, cpu_threads: int):
    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise TranscriptionError(
            "transcription_runtime_missing",
            "The faster-whisper transcription runtime is not installed.",
        ) from exc

    cache_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    cache_dir.chmod(0o700)
    try:
        return WhisperModel(
            model_name,
            device="cpu",
            compute_type="int8",
            cpu_threads=cpu_threads,
            download_root=str(cache_dir),
        )
    except Exception as exc:
        raise TranscriptionError(
            "transcription_model_unavailable",
            "The configured speech recognition model could not be loaded.",
        ) from exc


def _extract_chunk(
    audio_path: Path,
    destination: Path,
    *,
    start_seconds: float,
    duration_seconds: float,
    ffmpeg_binary: str,
) -> None:
    temporary = destination.with_name(destination.name + ".partial")
    temporary.unlink(missing_ok=True)
    command = [
        ffmpeg_binary,
        "-nostdin",
        "-hide_banner",
        "-loglevel", "error",
        "-protocol_whitelist", "file,pipe",
        "-ss", f"{start_seconds:.3f}",
        "-i", str(audio_path.resolve()),
        "-t", f"{duration_seconds:.3f}",
        "-map", "0:a:0",
        "-vn", "-sn", "-dn",
        "-c:a", "copy",
        "-f", "wav",
        "-y", str(temporary.resolve()),
    ]
    try:
        completed = subprocess.run(
            command,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
            timeout=300,
        )
    except FileNotFoundError as exc:
        raise TranscriptionError("ffmpeg_unavailable", "FFmpeg is not installed or is not on PATH.") from exc
    except subprocess.TimeoutExpired as exc:
        temporary.unlink(missing_ok=True)
        raise TranscriptionError("transcription_chunk_timeout", "Audio chunk preparation exceeded its time limit.") from exc
    if completed.returncode != 0 or not temporary.is_file() or temporary.stat().st_size < 44:
        temporary.unlink(missing_ok=True)
        raise TranscriptionError("transcription_chunk_failed", "FFmpeg could not prepare an audio chunk.")
    temporary.chmod(0o600)
    temporary.replace(destination)


def _normalise_words(words: Any, offset_seconds: float, duration_seconds: float) -> list[dict[str, Any]]:
    output: list[dict[str, Any]] = []
    if not words:
        return output
    for word in words:
        start = _safe_number(getattr(word, "start", None))
        end = _safe_number(getattr(word, "end", None))
        text = getattr(word, "word", None)
        if start is None or end is None or end <= start or not isinstance(text, str):
            continue
        absolute_start = max(0.0, min(duration_seconds, offset_seconds + start))
        absolute_end = max(absolute_start, min(duration_seconds, offset_seconds + end))
        if absolute_end <= absolute_start:
            continue
        output.append({
            "start": round(absolute_start, 3),
            "end": round(absolute_end, 3),
            "text": text[:300],
        })
    return output


def _read_chunk(path: Path, expected_index: int) -> dict[str, Any] | None:
    if path.is_symlink() or not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    if (
        not isinstance(payload, dict)
        or payload.get("chunkIndex") != expected_index
        or not isinstance(payload.get("segments"), list)
        or len(payload["segments"]) > MAX_SEGMENTS
    ):
        return None
    return payload


def _file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def transcribe_audio(
    audio_path: Path,
    output_dir: Path,
    *,
    source_asset_id: str,
    duration_seconds: float,
    model_name: str = "base",
    model_cache_dir: Path = Path("/var/cache/clipforge/models"),
    cpu_threads: int = 2,
    chunk_seconds: int = 300,
    beam_size: int = 1,
    language: str | None = None,
    ffmpeg_binary: str = "ffmpeg",
    model_factory: Callable[..., Any] | None = None,
    chunk_extractor: Callable[..., None] | None = None,
    progress_callback: Callable[[dict[str, Any]], None] | None = None,
) -> TranscriptionResult:
    """Create a resumable, timestamped local transcript from normalized 16 kHz mono WAV."""
    if model_name not in SUPPORTED_MODELS:
        raise TranscriptionError("transcription_model_invalid", "The configured speech recognition model is unsupported.")
    if cpu_threads < 1 or cpu_threads > 8 or beam_size < 1 or beam_size > 5:
        raise TranscriptionError("transcription_config_invalid", "The speech recognition settings are outside supported limits.")
    if not source_asset_id or len(source_asset_id) > 128:
        raise TranscriptionError("transcription_input_invalid", "The source asset identifier is invalid.")
    if not audio_path.is_file() or audio_path.is_symlink() or audio_path.stat().st_size < 44:
        raise TranscriptionError("audio_artifact_missing", "The normalized WAV artifact is missing or invalid.")
    if not math.isfinite(duration_seconds) or duration_seconds <= 0 or duration_seconds > 43200:
        raise TranscriptionError("transcription_input_invalid", "The audio duration is outside supported limits.")
    if language is not None and (len(language) < 2 or len(language) > 12):
        raise TranscriptionError("transcription_config_invalid", "The configured transcription language is invalid.")

    output_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    if output_dir.is_symlink():
        raise TranscriptionError("transcription_storage_invalid", "The transcript directory must not be a symlink.")
    output_dir.chmod(0o700)
    chunk_dir = output_dir / "chunks"
    if chunk_dir.is_symlink():
        raise TranscriptionError("transcription_storage_invalid", "The transcript checkpoint directory must not be a symlink.")
    chunk_dir.mkdir(mode=0o700, exist_ok=True)

    audio_size_bytes = audio_path.stat().st_size
    audio_sha256 = _file_sha256(audio_path)
    state = {
        "formatVersion": TRANSCRIPT_FORMAT_VERSION,
        "sourceAssetId": source_asset_id,
        "audioSizeBytes": audio_size_bytes,
        "audioSha256": audio_sha256,
        "durationSeconds": round(duration_seconds, 3),
        "model": model_name,
        "chunkSeconds": chunk_seconds,
        "languageOverride": language,
    }
    state_path = output_dir / "transcription-state.json"
    if state_path.is_symlink():
        raise TranscriptionError("transcription_storage_invalid", "The transcript state file must not be a symlink.")
    try:
        previous_state = json.loads(state_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        previous_state = None
    if previous_state != state:
        shutil.rmtree(chunk_dir)
        chunk_dir.mkdir(mode=0o700)
        for stale_name in ("transcript.json", "transcription-summary.json"):
            stale_path = output_dir / stale_name
            if stale_path.is_symlink():
                raise TranscriptionError("transcription_storage_invalid", "Transcript artifacts must not be symlinks.")
            stale_path.unlink(missing_ok=True)
        _atomic_json(state_path, state)

    transcript_path = output_dir / "transcript.json"
    summary_path = output_dir / "transcription-summary.json"
    if not transcript_path.is_symlink() and not summary_path.is_symlink() and transcript_path.is_file() and summary_path.is_file():
        try:
            cached = json.loads(summary_path.read_text(encoding="utf-8"))
            if (
                cached.get("sourceAssetId") == source_asset_id
                and cached.get("audioSizeBytes") == audio_path.stat().st_size
                and cached.get("model") == model_name
                and cached.get("sha256") == _file_sha256(transcript_path)
                and transcript_path.stat().st_size <= MAX_TRANSCRIPT_BYTES
            ):
                return TranscriptionResult(
                    transcript_path=transcript_path,
                    model=model_name,
                    language=cached.get("language"),
                    segment_count=int(cached["segmentCount"]),
                    size_bytes=transcript_path.stat().st_size,
                    sha256=cached["sha256"],
                )
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            pass

    windows = list(chunk_windows(duration_seconds, chunk_seconds))
    checkpoint_paths = [chunk_dir / f"{index:06d}.json" for index, *_ in windows]
    missing = [
        window for window, path in zip(windows, checkpoint_paths)
        if _read_chunk(path, window[0]) is None
    ]
    if progress_callback:
        progress_callback({"event": "started", "totalChunks": len(windows), "completedChunks": len(windows) - len(missing)})

    model = None
    if missing:
        factory = model_factory or _make_model
        try:
            model = factory(model_name, Path(model_cache_dir), cpu_threads)
        except TranscriptionError:
            raise
        except Exception as exc:
            raise TranscriptionError("transcription_model_unavailable", "The speech recognition model could not be initialized.") from exc

    extractor = chunk_extractor or _extract_chunk
    completed_count = len(windows) - len(missing)
    language_counts: Counter[str] = Counter()
    language_probabilities: dict[str, list[float]] = {}
    segment_count = 0

    for index, central_start, central_end, extract_start, extract_end in windows:
        checkpoint = _read_chunk(checkpoint_paths[index], index)
        chunk_was_missing = checkpoint is None
        if chunk_was_missing:
            chunk_path = chunk_dir / f"{index:06d}.wav"
            try:
                extractor(
                    audio_path,
                    chunk_path,
                    start_seconds=extract_start,
                    duration_seconds=extract_end - extract_start,
                    ffmpeg_binary=ffmpeg_binary,
                )
                segments, info = model.transcribe(
                    str(chunk_path),
                    beam_size=beam_size,
                    language=language,
                    multilingual=True,
                    condition_on_previous_text=False,
                    vad_filter=True,
                    word_timestamps=True,
                )
                normalised: list[dict[str, Any]] = []
                for segment in segments:
                    local_start = _safe_number(getattr(segment, "start", None))
                    local_end = _safe_number(getattr(segment, "end", None))
                    text = getattr(segment, "text", None)
                    if local_start is None or local_end is None or local_end <= local_start or not isinstance(text, str):
                        continue
                    absolute_start = max(0.0, min(duration_seconds, extract_start + local_start))
                    absolute_end = max(absolute_start, min(duration_seconds, extract_start + local_end))
                    midpoint = (absolute_start + absolute_end) / 2
                    if absolute_end <= absolute_start or midpoint < central_start or midpoint >= central_end:
                        continue
                    words = _normalise_words(
                        getattr(segment, "words", None),
                        extract_start,
                        duration_seconds,
                    )
                    normalised.append({
                        "start": round(absolute_start, 3),
                        "end": round(absolute_end, 3),
                        "text": text.strip()[:2000],
                        "words": words,
                    })
                    if len(normalised) > MAX_SEGMENTS:
                        raise TranscriptionError("transcription_output_limit_exceeded", "The transcript contains too many segments.")
                chunk_language = getattr(info, "language", None)
                probability = _safe_number(getattr(info, "language_probability", None))
                checkpoint = {
                    "chunkIndex": index,
                    "language": chunk_language if isinstance(chunk_language, str) and len(chunk_language) <= 12 else None,
                    "languageProbability": probability,
                    "segments": normalised,
                }
                _atomic_json(checkpoint_paths[index], checkpoint)
            except TranscriptionError:
                raise
            except subprocess.TimeoutExpired as exc:
                raise TranscriptionError("transcription_chunk_timeout", "An audio chunk exceeded its processing time limit.") from exc
            except Exception as exc:
                raise TranscriptionError("transcription_inference_failed", "Speech recognition failed while processing an audio chunk.") from exc
            finally:
                (chunk_dir / f"{index:06d}.wav").unlink(missing_ok=True)

        chunk_language = checkpoint.get("language")
        probability = _safe_number(checkpoint.get("languageProbability"))
        if isinstance(chunk_language, str) and chunk_language:
            language_counts[chunk_language] += 1
            if probability is not None:
                language_probabilities.setdefault(chunk_language, []).append(probability)
        chunk_segments = checkpoint.get("segments", [])
        segment_count += len(chunk_segments)
        if segment_count > MAX_SEGMENTS:
            raise TranscriptionError("transcription_output_limit_exceeded", "The transcript contains too many segments.")

        if progress_callback:
            completed_count += 1 if chunk_was_missing else 0
            progress_callback({
                "event": "progress",
                "completedChunks": completed_count,
                "totalChunks": len(windows),
            })

    detected_language = language_counts.most_common(1)[0][0] if language_counts else language
    temporary_transcript = transcript_path.with_name("transcript.json.partial")
    temporary_transcript.unlink(missing_ok=True)
    try:
        with temporary_transcript.open("w", encoding="utf-8") as target:
            # Stream segments from chunk checkpoints to keep memory bounded on long VODs.
            header = {
                "formatVersion": TRANSCRIPT_FORMAT_VERSION,
                "sourceAssetId": source_asset_id,
                "durationSeconds": round(duration_seconds, 3),
                "model": model_name,
                "language": detected_language,
            }
            target.write(json.dumps(header, ensure_ascii=False, separators=(",", ":"))[:-1])
            target.write(',"segments":[')
            first_segment = True
            for index, *_ in windows:
                payload = _read_chunk(checkpoint_paths[index], index)
                if payload is None:
                    raise TranscriptionError("transcription_checkpoint_invalid", "A transcript checkpoint could not be read.")
                for segment in payload["segments"]:
                    if not first_segment:
                        target.write(",")
                    target.write(json.dumps(segment, ensure_ascii=False, separators=(",", ":")))
                    first_segment = False
            target.write("]}")
        temporary_transcript.chmod(0o600)
        size = temporary_transcript.stat().st_size
        if size < 2 or size > MAX_TRANSCRIPT_BYTES:
            raise TranscriptionError("transcription_output_limit_exceeded", "The transcript output exceeded its storage limit.")
        temporary_transcript.replace(transcript_path)
    finally:
        temporary_transcript.unlink(missing_ok=True)

    digest = _file_sha256(transcript_path)
    summary = {
        **state,
        "language": detected_language,
        "languageProbability": (
            sum(language_probabilities.get(detected_language, [])) /
            len(language_probabilities[detected_language])
            if detected_language in language_probabilities and language_probabilities[detected_language]
            else None
        ),
        "segmentCount": segment_count,
        "sizeBytes": transcript_path.stat().st_size,
        "sha256": digest,
    }
    _atomic_json(summary_path, summary)
    return TranscriptionResult(
        transcript_path=transcript_path,
        model=model_name,
        language=detected_language,
        segment_count=segment_count,
        size_bytes=transcript_path.stat().st_size,
        sha256=digest,
    )
