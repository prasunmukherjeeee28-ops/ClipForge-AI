from __future__ import annotations

import json

from clipforge_processor.moment_scoring import MomentEvidence
from clipforge_processor.semantic_scoring import GeminiSemanticAdapter, SemanticScoringError


def make_evidence(index: int = 0) -> MomentEvidence:
    return MomentEvidence(
        start_seconds=10 + index * 40,
        end_seconds=35 + index * 40,
        heuristic_score=0.6,
        acoustic_salience=0.7,
        transcript_velocity=0.8,
        narrative_arc=0.5,
        novelty=0.4,
        word_count=35,
        marker_count=2,
        rationale="speech and audio cues",
        transcript_excerpt="The player misses the jump and reacts with surprise.",
    )


class FakeResponse:
    def __init__(self, payload):
        self.payload = payload

    def raise_for_status(self):
        return None

    def json(self):
        return self.payload


def test_gemini_adapter_refines_scores_and_returns_grounded_titles(monkeypatch) -> None:
    captured = {}

    def fake_post(url, *, headers, json, timeout):
        captured.update({"url": url, "headers": headers, "body": json, "timeout": timeout})
        return FakeResponse({
            "candidates": [{
                "content": {
                    "parts": [{
                        "text": json_module.dumps({
                            "highlights": [{
                                "index": 0,
                                "score": 0.9,
                                "category": "fail",
                                "title_hint": "The jump goes horribly wrong",
                                "rationale": "The excerpt describes a failed jump and an immediate reaction.",
                            }]
                        })
                    }]
                }
            }]
        })

    import json as json_module
    monkeypatch.setattr("clipforge_processor.semantic_scoring.httpx.post", fake_post)

    result = GeminiSemanticAdapter("test-api-key-12345").score([make_evidence()])

    assert result[0].category == "fail"
    assert result[0].score == 0.795
    assert result[0].title_hint == "The jump goes horribly wrong"
    assert "transcript_excerpt" in captured["body"]["contents"][0]["parts"][0]["text"]
    assert captured["headers"] == {"x-goog-api-key": "test-api-key-12345"}
    assert captured["timeout"] == 25.0


def test_gemini_adapter_ignores_duplicate_or_out_of_range_indices(monkeypatch) -> None:
    import json as json_module

    def fake_post(*args, **kwargs):
        return FakeResponse({
            "candidates": [{
                "content": {"parts": [{
                    "text": json_module.dumps({"highlights": [
                        {"index": 90, "score": 1.0, "category": "action", "title_hint": "Invented", "rationale": "bad"},
                        {"index": 0, "score": 0.8, "category": "action", "title_hint": "", "rationale": "Valid action"},
                        {"index": 0, "score": 1.0, "category": "funny", "title_hint": "Duplicate", "rationale": "duplicate"},
                    ]})
                }]}
            }]
        })

    monkeypatch.setattr("clipforge_processor.semantic_scoring.httpx.post", fake_post)
    result = GeminiSemanticAdapter("test-api-key-12345").score([make_evidence()])

    assert result[0].category == "action"
    assert result[0].title_hint is None
    assert result[0].score == 0.73


def test_gemini_adapter_fails_closed_on_provider_errors(monkeypatch) -> None:
    import httpx

    def fake_post(*args, **kwargs):
        raise httpx.TimeoutException("timed out")

    monkeypatch.setattr("clipforge_processor.semantic_scoring.httpx.post", fake_post)
    try:
        GeminiSemanticAdapter("test-api-key-12345").score([make_evidence()])
    except SemanticScoringError:
        pass
    else:
        raise AssertionError("Expected semantic provider failure to be surfaced for fallback.")
