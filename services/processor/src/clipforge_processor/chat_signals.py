from __future__ import annotations

import re
import statistics
from collections import Counter
from dataclasses import dataclass
from typing import Iterable


MAX_CHAT_MESSAGES = 100_000
MAX_STREAM_SECONDS = 43_200
_REACTION_PATTERNS = (
    re.compile(r"\b(?:lol|lmao|lmfao|rofl)\b", re.IGNORECASE),
    re.compile(r"\b(?:no way|what|wtf|omg|oh my god)\b", re.IGNORECASE),
    re.compile(r"\b(?:lets go|let's go|insane|crazy|clip that)\b", re.IGNORECASE),
    re.compile(r"[😂🤣💀😭🔥😱]{1,}", re.UNICODE),
)
_SPACE_RE = re.compile(r"\s+")


@dataclass(frozen=True)
class ChatMessage:
    """A platform-neutral chat event timestamped against the stream timeline."""

    timestamp_seconds: float
    author: str
    text: str


@dataclass(frozen=True)
class ChatReactionWindow:
    """A bounded audience-reaction signal; it is evidence, not a clip decision."""

    start_seconds: float
    end_seconds: float
    message_count: int
    unique_authors: int
    reaction_count: int
    duplicate_ratio: float
    score: float

    def as_dict(self) -> dict[str, float | int]:
        return {
            "startSeconds": round(self.start_seconds, 3),
            "endSeconds": round(self.end_seconds, 3),
            "messageCount": self.message_count,
            "uniqueAuthors": self.unique_authors,
            "reactionCount": self.reaction_count,
            "duplicateRatio": round(self.duplicate_ratio, 4),
            "score": round(self.score, 4),
        }


def _normalise_text(value: str) -> str:
    return _SPACE_RE.sub(" ", value.strip().lower())[:500]


def _reaction_count(text: str) -> int:
    return sum(1 for pattern in _REACTION_PATTERNS if pattern.search(text))


def score_chat_reactions(
    messages: Iterable[ChatMessage],
    *,
    duration_seconds: float,
    window_seconds: int = 10,
    step_seconds: int = 5,
    min_messages: int = 6,
    min_unique_authors: int = 3,
    max_results: int = 100,
) -> list[ChatReactionWindow]:
    """Find audience-reaction bursts without allowing duplicate spam to dominate.

    Input timestamps must already be mapped to the stream's media timeline by a
    trusted platform adapter. This function performs no network access and does
    not connect to Twitch or YouTube itself.
    """
    if not 0 < duration_seconds <= MAX_STREAM_SECONDS:
        raise ValueError("duration_seconds is outside supported bounds")
    if not 5 <= window_seconds <= 60 or not 1 <= step_seconds <= window_seconds:
        raise ValueError("chat window settings are outside supported bounds")
    if min_messages < 2 or min_unique_authors < 2 or not 1 <= max_results <= 1000:
        raise ValueError("chat scoring thresholds are outside supported bounds")

    accepted: list[tuple[float, str, str]] = []
    for message in messages:
        if len(accepted) >= MAX_CHAT_MESSAGES:
            break
        if not isinstance(message, ChatMessage):
            continue
        timestamp = message.timestamp_seconds
        if not isinstance(timestamp, (int, float)) or not 0 <= timestamp < duration_seconds:
            continue
        author = message.author.strip()[:100].lower()
        text = _normalise_text(message.text)
        if not author or not text:
            continue
        accepted.append((float(timestamp), author, text))

    if not accepted:
        return []

    accepted.sort(key=lambda item: item[0])
    window_count = max(1, int((duration_seconds - 1) // step_seconds) + 1)
    counts = [0] * window_count
    buckets: list[list[tuple[str, str]]] = [[] for _ in range(window_count)]

    for timestamp, author, text in accepted:
        index = min(window_count - 1, int(timestamp // step_seconds))
        counts[index] += 1
        buckets[index].append((author, text))

    baseline = statistics.median(counts) if counts else 0.0
    results: list[ChatReactionWindow] = []
    left = 0
    right = 0
    for index in range(window_count):
        start = float(index * step_seconds)
        end = min(duration_seconds, start + window_seconds)
        if end - start < window_seconds * 0.5:
            continue
        while right < len(accepted) and accepted[right][0] < end:
            right += 1
        while left < right and accepted[left][0] < start:
            left += 1
        if left >= right:
            continue
        in_window = [(author, text) for _, author, text in accepted[left:right]]
        message_count = len(in_window)
        unique_authors = len({author for author, _ in in_window})
        if message_count < min_messages or unique_authors < min_unique_authors:
            continue

        text_counts = Counter(text for _, text in in_window)
        duplicate_messages = sum(count - 1 for count in text_counts.values() if count > 1)
        duplicate_ratio = duplicate_messages / message_count
        reaction_count = sum(_reaction_count(text) for _, text in in_window)

        volume_score = min(1.0, message_count / max(float(min_messages), baseline * 2.0, 1.0))
        participation_score = min(1.0, unique_authors / max(float(min_unique_authors * 2), 1.0))
        reaction_score = reaction_count / message_count
        score = (
            0.45 * volume_score
            + 0.35 * participation_score
            + 0.20 * min(1.0, reaction_score)
        ) * (1.0 - 0.85 * duplicate_ratio)
        if score <= 0:
            continue

        results.append(ChatReactionWindow(
            start_seconds=start,
            end_seconds=end,
            message_count=message_count,
            unique_authors=unique_authors,
            reaction_count=reaction_count,
            duplicate_ratio=duplicate_ratio,
            score=max(0.0, min(1.0, score)),
        ))

    # Keep the strongest non-overlapping windows so one chat burst is not
    # reported repeatedly by adjacent sliding windows.
    ranked = sorted(results, key=lambda item: (-item.score, item.start_seconds))
    kept: list[ChatReactionWindow] = []
    for candidate in ranked:
        if all(
            min(candidate.end_seconds, prior.end_seconds)
            - max(candidate.start_seconds, prior.start_seconds)
            <= 0
            for prior in kept
        ):
            kept.append(candidate)
            if len(kept) >= max_results:
                break
    return sorted(kept, key=lambda item: item.start_seconds)
