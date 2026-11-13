from __future__ import annotations

import argparse
import json
from pathlib import Path

from .moments import detect_moments


def main() -> int:
    parser = argparse.ArgumentParser(description="Detect candidate moments from private ClipForge artifacts.")
    parser.add_argument("--audio", required=True)
    parser.add_argument("--transcript", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--max-results", type=int, default=50)
    parser.add_argument("--threshold", type=float, default=0.42)
    args = parser.parse_args()

    output = Path(args.output)
    if output.is_symlink():
        raise SystemExit(2)
    output.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    candidates = detect_moments(
        Path(args.audio),
        Path(args.transcript),
        score_threshold=args.threshold,
        max_results=min(args.max_results, 50),
    )
    payload = [candidate.as_dict() for candidate in candidates]
    temporary = output.with_name(output.name + ".partial")
    temporary.unlink(missing_ok=True)
    temporary.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.chmod(0o600)
    temporary.replace(output)
    print(json.dumps({"event": "complete", "candidateCount": len(payload)}, separators=(",", ":")), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
