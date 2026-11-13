from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from .transcription import TranscriptionError, transcribe_audio


def emit(payload: dict[str, object]) -> None:
    print(json.dumps(payload, separators=(",", ":"), ensure_ascii=False), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Transcribe one private ClipForge WAV artifact.")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--source-asset-id", required=True)
    parser.add_argument("--duration", required=True, type=float)
    parser.add_argument("--model", default="base")
    parser.add_argument("--model-cache-dir", required=True)
    parser.add_argument("--cpu-threads", type=int, default=2)
    parser.add_argument("--chunk-seconds", type=int, default=300)
    parser.add_argument("--beam-size", type=int, default=1)
    parser.add_argument("--language", default=None)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    args = parser.parse_args()

    try:
        result = transcribe_audio(
            Path(args.audio),
            Path(args.output_dir),
            source_asset_id=args.source_asset_id,
            duration_seconds=args.duration,
            model_name=args.model,
            model_cache_dir=Path(args.model_cache_dir),
            cpu_threads=args.cpu_threads,
            chunk_seconds=args.chunk_seconds,
            beam_size=args.beam_size,
            language=args.language,
            ffmpeg_binary=args.ffmpeg,
            progress_callback=emit,
        )
        emit({
            "event": "complete",
            "model": result.model,
            "language": result.language,
            "segmentCount": result.segment_count,
            "sizeBytes": result.size_bytes,
            "sha256": result.sha256,
        })
        return 0
    except TranscriptionError as exc:
        emit({"event": "error", "code": exc.code})
        return 1
    except Exception:
        emit({"event": "error", "code": "transcription_failed"})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
