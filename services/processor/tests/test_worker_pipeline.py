from __future__ import annotations

import json
from pathlib import Path

from clipforge_processor.worker import _clip_title, _select_render_candidates


def test_select_render_candidates_ranks_and_removes_heavy_overlap() -> None:
    candidates = [
        {"startSeconds": 10.0, "endSeconds": 40.0, "score": 0.8},
        {"startSeconds": 12.0, "endSeconds": 42.0, "score": 0.95},
        {"startSeconds": 50.0, "endSeconds": 70.0, "score": 0.7},
        {"startSeconds": 80.0, "endSeconds": 200.0, "score": 0.6},
        {"startSeconds": 90.0, "endSeconds": 92.0, "score": 1.0},
    ]

    selected = _select_render_candidates(candidates, limit=3)

    assert [item["startSeconds"] for item in selected] == [12.0, 50.0, 80.0]
    assert all(5 <= item["endSeconds"] - item["startSeconds"] <= 120 for item in selected)


def test_clip_title_uses_transcript_excerpt_inside_candidate(tmp_path: Path) -> None:
    transcript = tmp_path / "transcript.json"
    transcript.write_text(json.dumps({
        "segments": [
            {"start": 1.0, "end": 4.0, "text": "Earlier setup"},
            {"start": 10.0, "end": 12.0, "text": "No way, that actually worked! More words."},
            {"start": 14.0, "end": 16.0, "text": "Everyone saw that"},
        ]
    }), encoding="utf-8")

    title = _clip_title(transcript, 9.0, 20.0, 1)

    assert title == "No way, that actually worked"


def test_clip_title_falls_back_when_transcript_has_no_matching_text(tmp_path: Path) -> None:
    transcript = tmp_path / "transcript.json"
    transcript.write_text(json.dumps({"segments": []}), encoding="utf-8")

    assert _clip_title(transcript, 10.0, 20.0, 2) == "Gameplay highlight 2"
