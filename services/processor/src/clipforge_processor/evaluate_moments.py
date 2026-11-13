from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from clipforge_processor.evaluation import EvaluationInputError, evaluate_files


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Evaluate ranked ClipForge moment candidates against manually labelled time ranges."
    )
    parser.add_argument("--labels", required=True, type=Path, help="JSON file containing a highlights array")
    parser.add_argument("--predictions", required=True, type=Path, help="JSON file containing candidates or predictions")
    parser.add_argument("--k", type=int, default=3, help="Number of top-ranked predictions to evaluate (default: 3)")
    parser.add_argument("--iou-threshold", type=float, default=0.3, help="Temporal IoU match threshold (default: 0.3)")
    args = parser.parse_args()
    try:
        result = evaluate_files(args.labels, args.predictions, k=args.k, iou_threshold=args.iou_threshold)
    except EvaluationInputError as exc:
        print(f"evaluation input error: {exc}", file=sys.stderr)
        return 2
    print(json.dumps(result, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
