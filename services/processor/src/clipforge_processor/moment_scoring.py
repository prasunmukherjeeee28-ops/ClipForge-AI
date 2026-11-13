from __future__ import annotations

from typing import Literal, Protocol, Sequence

from pydantic import BaseModel, ConfigDict, Field, model_validator


MomentCategory = Literal["funny", "action", "fail", "glitch", "banter", "unknown"]


class MomentEvidence(BaseModel):
    """Bounded, provider-neutral evidence; raw transcript text is intentionally excluded."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    start_seconds: float = Field(ge=0, le=43200)
    end_seconds: float = Field(gt=0, le=43200)
    heuristic_score: float = Field(ge=0, le=1)
    acoustic_salience: float = Field(ge=0, le=1)
    transcript_velocity: float = Field(ge=0, le=1)
    narrative_arc: float = Field(ge=0, le=1)
    novelty: float = Field(ge=0, le=1)
    word_count: int = Field(ge=0, le=10000)
    marker_count: int = Field(ge=0, le=1000)
    rationale: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_window(self) -> "MomentEvidence":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("end_seconds must be after start_seconds")
        return self


class HighlightScore(BaseModel):
    """Validated structured output for a future optional semantic refinement model."""

    model_config = ConfigDict(extra="forbid", frozen=True)

    start_seconds: float = Field(ge=0, le=43200)
    end_seconds: float = Field(gt=0, le=43200)
    score: float = Field(ge=0, le=1)
    category: MomentCategory = "unknown"
    title_hint: str | None = Field(default=None, max_length=120)
    rationale: str = Field(min_length=1, max_length=500)

    @model_validator(mode="after")
    def validate_window(self) -> "HighlightScore":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("end_seconds must be after start_seconds")
        return self


class MomentScoringAdapter(Protocol):
    """Provider-independent boundary for optional semantic refinement."""

    def score(self, evidence: Sequence[MomentEvidence]) -> list[HighlightScore]:
        ...


class LocalHeuristicAdapter:
    """Deterministic no-network adapter; it never invents semantic categories or titles."""

    def score(self, evidence: Sequence[MomentEvidence]) -> list[HighlightScore]:
        return [
            HighlightScore(
                start_seconds=item.start_seconds,
                end_seconds=item.end_seconds,
                score=item.heuristic_score,
                category="unknown",
                title_hint=None,
                rationale=item.rationale,
            )
            for item in evidence
        ]
