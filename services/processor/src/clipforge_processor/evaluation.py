from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any


class EvaluationInputError(ValueError):
    """Raised when benchmark annotations or predictions are malformed."""


def _number(value: Any, field: str) -> float:
    if isinstance(value, bool):
        raise EvaluationInputError(f"{field} must be a finite number")
    try:
        result = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise EvaluationInputError(f"{field} must be a finite number") from exc
    if not math.isfinite(result):
        raise EvaluationInputError(f"{field} must be a finite number")
    return result


def _window(item: Any, index: int, kind: str) -> dict[str, float]:
    if not isinstance(item, dict):
        raise EvaluationInputError(f"{kind}[{index}] must be an object")
    start = _number(item.get("startSeconds", item.get("start_seconds", item.get("start"))), f"{kind}[{index}].startSeconds")
    end = _number(item.get("endSeconds", item.get("end_seconds", item.get("end"))), f"{kind}[{index}].endSeconds")
    if start < 0 or end <= start:
        raise EvaluationInputError(f"{kind}[{index}] must have 0 <= startSeconds < endSeconds")
    score = _number(item.get("score", 0), f"{kind}[{index}].score")
    return {"start": start, "end": end, "score": score}


def _read_windows(payload: Any, keys: tuple[str, ...], kind: str) -> list[dict[str, float]]:
    items = payload
    if isinstance(payload, dict):
        items = next((payload[key] for key in keys if key in payload), None)
    if not isinstance(items, list):
        raise EvaluationInputError(f"{kind} must be an array (or an object containing {', '.join(keys)})")
    return [_window(item, index, kind) for index, item in enumerate(items)]


def temporal_iou(left: dict[str, float], right: dict[str, float]) -> float:
    intersection = max(0.0, min(left["end"], right["end"]) - max(left["start"], right["start"]))
    union = max(left["end"], right["end"]) - min(left["start"], right["start"])
    return intersection / union if union > 0 else 0.0


def evaluate_windows(
    labels: list[dict[str, float]],
    predictions: list[dict[str, float]],
    *,
    k: int = 3,
    iou_threshold: float = 0.3,
) -> dict[str, Any]:
    if k < 1:
        raise EvaluationInputError("k must be at least 1")
    if not 0 < iou_threshold <= 1:
        raise EvaluationInputError("iou_threshold must be in (0, 1]")
    labels = [_window(item, index, "highlights") for index, item in enumerate(labels)]
    predictions = [_window(item, index, "candidates") for index, item in enumerate(predictions)]
    ranked = sorted(predictions, key=lambda item: (-item["score"], item["start"], item["end"]))
    selected = ranked[:k]

    duplicate_indices: set[int] = set()
    for left_index, left in enumerate(selected):
        for right_index in range(left_index + 1, len(selected)):
            if temporal_iou(left, selected[right_index]) >= iou_threshold:
                duplicate_indices.update((left_index, right_index))

    # Build threshold-qualified edges, preferring higher-IoU labels per prediction.
    # Augmenting paths preserve maximum match cardinality; a greedy global edge
    # sort can incorrectly leave a prediction unmatched when reassignment is possible.
    adjacency = [
        sorted(
            (
                (temporal_iou(prediction, label), label_index)
                for label_index, label in enumerate(labels)
                if temporal_iou(prediction, label) >= iou_threshold
            ),
            key=lambda pair: (-pair[0], pair[1]),
        )
        for prediction in selected
    ]
    label_to_prediction: dict[int, int] = {}

    def assign(prediction_index: int, visited_labels: set[int]) -> bool:
        for _, label_index in adjacency[prediction_index]:
            if label_index in visited_labels:
                continue
            visited_labels.add(label_index)
            previous = label_to_prediction.get(label_index)
            if previous is None or assign(previous, visited_labels):
                label_to_prediction[label_index] = prediction_index
                return True
        return False

    for prediction_index in range(len(selected)):
        assign(prediction_index, set())

    matches = sorted(
        (
            (prediction_index, label_index)
            for label_index, prediction_index in label_to_prediction.items()
        ),
        key=lambda pair: pair[0],
    )
    boundary_errors: list[dict[str, float]] = []
    for prediction_index, label_index in matches:
        prediction = selected[prediction_index]
        label = labels[label_index]
        boundary_errors.append({
            "startSeconds": abs(prediction["start"] - label["start"]),
            "endSeconds": abs(prediction["end"] - label["end"]),
            "temporalIoU": temporal_iou(prediction, label),
        })

    matched_count = len(matches)
    boundary_values = [
        error
        for item in boundary_errors
        for error in (item["startSeconds"], item["endSeconds"])
    ]
    return {
        "labelCount": len(labels),
        "predictionCount": len(predictions),
        "evaluatedAtK": k,
        "iouThreshold": iou_threshold,
        "precisionAtK": matched_count / k,
        "recallAtK": matched_count / len(labels) if labels else 0.0,
        "matchedHighlights": matched_count,
        "unmatchedLabels": len(labels) - matched_count,
        "unmatchedPredictionsAtK": len(selected) - matched_count,
        "duplicatePredictionRateAtK": len(duplicate_indices) / len(selected) if selected else 0.0,
        "meanStartBoundaryErrorSeconds": (
            sum(item["startSeconds"] for item in boundary_errors) / matched_count if matched_count else None
        ),
        "meanEndBoundaryErrorSeconds": (
            sum(item["endSeconds"] for item in boundary_errors) / matched_count if matched_count else None
        ),
        "meanBoundaryErrorSeconds": (
            sum(boundary_values) / len(boundary_values) if boundary_values else None
        ),
        "matches": boundary_errors,
    }


def evaluate_files(
    labels_path: Path,
    predictions_path: Path,
    *,
    k: int = 3,
    iou_threshold: float = 0.3,
) -> dict[str, Any]:
    try:
        labels_payload = json.loads(labels_path.read_text(encoding="utf-8"))
        predictions_payload = json.loads(predictions_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise EvaluationInputError("could not read valid UTF-8 JSON input files") from exc
    labels = _read_windows(labels_payload, ("highlights", "labels"), "highlights")
    predictions = _read_windows(predictions_payload, ("candidates", "predictions"), "candidates")
    return evaluate_windows(labels, predictions, k=k, iou_threshold=iou_threshold)
