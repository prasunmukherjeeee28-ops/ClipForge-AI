from __future__ import annotations

import pytest

from clipforge_processor.chat_signals import ChatMessage, score_chat_reactions


def make_burst(start: int, *, authors: int = 8, text: str = "NO WAY 😂") -> list[ChatMessage]:
    return [
        ChatMessage(float(start + index % 8), f"viewer-{index % authors}", f"{text} {index}")
        for index in range(24)
    ]


def test_detects_reaction_spike_from_multiple_viewers() -> None:
    messages = make_burst(30)
    windows = score_chat_reactions(messages, duration_seconds=120)
    assert windows
    best = max(windows, key=lambda item: item.score)
    assert best.start_seconds <= 30
    assert best.end_seconds >= 38
    assert best.unique_authors >= 3
    assert best.reaction_count > 0
    assert 0 <= best.score <= 1


def test_duplicate_spam_is_heavily_discounted() -> None:
    messages = [
        ChatMessage(float(30 + index % 8), f"viewer-{index % 3}", "W")
        for index in range(24)
    ]
    windows = score_chat_reactions(messages, duration_seconds=120)
    assert windows
    assert max(item.duplicate_ratio for item in windows) >= 0.8
    assert max(item.score for item in windows) < 0.25



def test_common_reaction_from_distinct_viewers_is_not_spam() -> None:
    messages = [
        ChatMessage(float(30 + index), f"viewer-{index}", "LOL")
        for index in range(8)
    ]
    windows = score_chat_reactions(messages, duration_seconds=120)
    assert windows
    best = max(windows, key=lambda item: item.score)
    assert best.unique_authors == 8
    assert best.duplicate_ratio == 0
    assert best.score > 0.4


def test_single_viewer_cannot_create_a_reaction_spike() -> None:
    messages = [
        ChatMessage(float(30 + index % 8), "one-viewer", "LOL NO WAY")
        for index in range(40)
    ]
    assert score_chat_reactions(messages, duration_seconds=120) == []


def test_ignores_invalid_timestamps_and_empty_messages() -> None:
    messages = [
        ChatMessage(-1, "a", "LOL"),
        ChatMessage(121, "b", "LOL"),
        ChatMessage(20, "c", "   "),
    ]
    assert score_chat_reactions(messages, duration_seconds=120) == []


def test_rejects_unbounded_window_settings() -> None:
    with pytest.raises(ValueError):
        score_chat_reactions([], duration_seconds=120, window_seconds=120)
