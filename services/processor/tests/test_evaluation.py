from __future__ import annotations

import json

import pytest

from clipforge_processor.evaluation import EvaluationInputError, evaluate_files, evaluate_windows


def window(start: float, end: float, score: float = 1.0) -> dict[str, float]:
    return {"start": start, "end": end, "score": score}


def test_perfect_predictions_have_full_precision_recall_and_zero_boundary_error() -> None:
    labels = [window(10, 20), window(40, 50)]
    predictions = [window(10, 20, 0.9), window(40, 50, 0.8)]
    result = evaluate_windows(labels, predictions, k=2)
    assert result["precisionAtK"] == 1.0
    assert result["recallAtK"] == 1.0
    assert result["meanBoundaryErrorSeconds"] == 0.0
    assert result["duplicatePredictionRateAtK"] == 0.0


def test_matching_is_one_to_one_and_reports_boundary_error() -> None:
    labels = [window(10, 20)]
    predictions = [window(11, 21, 0.9), window(10, 20, 0.8)]
    result = evaluate_windows(labels, predictions, k=2, iou_threshold=0.3)
    assert result["matchedHighlights"] == 1
    assert result["precisionAtK"] == 0.5
    assert result["recallAtK"] == 1.0
    assert result["meanStartBoundaryErrorSeconds"] == 0.0
    assert result["meanEndBoundaryErrorSeconds"] == 0.0
    assert result["duplicatePredictionRateAtK"] == 1.0


def test_matching_maximizes_cardinality_instead_of_greedily_losing_a_match() -> None:
    labels = [window(0, 10), window(2, 12)]
    predictions = [window(0, 10, 0.9), window(0, 8, 0.8)]
    result = evaluate_windows(labels, predictions, k=2, iou_threshold=0.6)
    assert result["matchedHighlights"] == 2
    assert result["precisionAtK"] == 1.0
    assert result["recallAtK"] == 1.0


def test_boundary_error_reports_offset_for_matched_prediction() -> None:
    result = evaluate_windows([window(10, 20)], [window(11, 21)], k=1)
    assert result["meanStartBoundaryErrorSeconds"] == 1.0
    assert result["meanEndBoundaryErrorSeconds"] == 1.0
    assert result["meanBoundaryErrorSeconds"] == 1.0


def test_precision_at_k_uses_requested_k_even_when_fewer_predictions_exist() -> None:
    result = evaluate_windows([window(1, 5)], [window(1, 5)], k=3)
    assert result["precisionAtK"] == pytest.approx(1 / 3)
    assert result["recallAtK"] == 1.0


def test_empty_labels_and_predictions_are_safe() -> None:
    result = evaluate_windows([], [], k=3)
    assert result["precisionAtK"] == 0.0
    assert result["recallAtK"] == 0.0
    assert result["meanBoundaryErrorSeconds"] is None


def test_file_reader_accepts_detector_camel_case_payloads(tmp_path) -> None:
    labels = tmp_path / "labels.json"
    predictions = tmp_path / "predictions.json"
    labels.write_text(json.dumps({"highlights": [{"startSeconds": 12, "endSeconds": 24}]}))
    predictions.write_text(json.dumps({"candidates": [{"startSeconds": 12, "endSeconds": 24, "score": 0.91}]}))
    result = evaluate_files(labels, predictions, k=1)
    assert result["matchedHighlights"] == 1


@pytest.mark.parametrize("payload", [
    [{"startSeconds": -1, "endSeconds": 2}],
    [{"startSeconds": 2, "endSeconds": 2}],
    [{"startSeconds": 1, "endSeconds": 3, "score": float("nan")}],
])
def test_invalid_windows_are_rejected(payload) -> None:
    with pytest.raises(EvaluationInputError):
        evaluate_windows(
            [{"start": 1, "end": 3, "score": 1}],
            [{"start": item["startSeconds"], "end": item["endSeconds"], "score": item.get("score", 0)} for item in payload],
        )
