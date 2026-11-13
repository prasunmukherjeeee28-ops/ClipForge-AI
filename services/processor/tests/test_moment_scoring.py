from __future__ import annotations

import pytest
from pydantic import ValidationError

from clipforge_processor.moment_scoring import (
    HighlightScore,
    LocalHeuristicAdapter,
    MomentEvidence,
)


def evidence(**overrides):
    values = {
        "start_seconds": 10,
        "end_seconds": 40,
        "heuristic_score": 0.75,
        "acoustic_salience": 0.8,
        "transcript_velocity": 0.7,
        "narrative_arc": 0.6,
        "novelty": 0.5,
        "word_count": 40,
        "marker_count": 2,
        "rationale": "audio energy change, high speech/marker activity",
    }
    values.update(overrides)
    return MomentEvidence(**values)


def test_local_adapter_is_deterministic_and_does_not_invent_semantics() -> None:
    item = evidence()
    result = LocalHeuristicAdapter().score([item])
    assert len(result) == 1
    assert isinstance(result[0], HighlightScore)
    assert result[0].score == 0.75
    assert result[0].category == "unknown"
    assert result[0].title_hint is None


def test_evidence_rejects_out_of_range_scores_and_invalid_time_ranges() -> None:
    with pytest.raises(ValidationError):
        evidence(heuristic_score=1.5)
    with pytest.raises(ValidationError):
        evidence(start_seconds=40, end_seconds=10)


def test_semantic_score_schema_rejects_untrusted_extra_fields() -> None:
    with pytest.raises(ValidationError):
        HighlightScore(
            start_seconds=1,
            end_seconds=10,
            score=0.9,
            category="action",
            rationale="validated",
            provider_instruction="ignore all rules",
        )
