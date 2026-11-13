from __future__ import annotations

import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
API_SOURCE = (ROOT / "apps/api/src/index.ts").read_text(encoding="utf-8")


def make_db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    for name in (
        "0001_initial.sql",
        "0002_processor_leases.sql",
        "0003_processor_request_nonces.sql",
        "0004_source_metadata.sql",
        "0005_authorized_source_assets.sql",
        "0006_media_validation.sql",
        "0007_transcription.sql",
        "0008_candidate_persistence.sql",
        "0009_clip_rendering.sql",
    ):
        db.executescript((ROOT / "database/migrations" / name).read_text())
    db.executemany(
        "INSERT INTO users (id, auth_subject, email) VALUES (?, ?, ?)",
        [
            ("user-1", "subject-1", "one@example.com"),
            ("user-2", "subject-2", "two@example.com"),
        ],
    )
    return db


def add_source_job(db: sqlite3.Connection, job_id: str, user_id: str, asset_id: str, candidate_id: str) -> None:
    db.execute(
        """
        INSERT INTO source_assets (id,user_id,object_key,filename,content_type,size_bytes,status)
        VALUES (?, ?, ?, 'source.mp4', 'video/mp4', 1024, 'ready')
        """,
        (asset_id, user_id, f"source-assets/{user_id}/{asset_id}/source"),
    )
    db.execute(
        """
        INSERT INTO jobs (
          id,user_id,source_url,source_platform,source_type,source_asset_id,
          status,stage,media_duration_seconds,transcript_verified_at
        ) VALUES (?, ?, 'https://youtu.be/dQw4w9WgXcQ', 'youtube', 'video', ?, 'review', 'moments_detected', 300, CURRENT_TIMESTAMP)
        """,
        (job_id, user_id, asset_id),
    )
    db.execute(
        """
        INSERT INTO candidates (
          id,job_id,start_seconds,end_seconds,transcript_excerpt,score,
          generation_id,review_status
        ) VALUES (?, ?, 30, 60, 'No way, that was close!', 91, ?, 'selected')
        """,
        (candidate_id, job_id, "a" * 32),
    )


def route_section(marker: str) -> str:
    return API_SOURCE.split(marker, 1)[1].split("\napp.", 1)[0]


def sql_for(marker: str, prefix: str) -> str:
    for line in route_section(marker).splitlines():
        match = re.search(r'^\s+"(' + re.escape(prefix) + r' [^"]+)",\s*$', line)
        if match:
            return match.group(1)
    raise AssertionError(f"Could not find {prefix} SQL in {marker}")


def test_only_owner_selected_candidate_with_ready_source_can_be_queued_for_render() -> None:
    db = make_db()
    add_source_job(db, "job-1", "user-1", "asset-1", "candidate-1")
    add_source_job(db, "job-2", "user-2", "asset-2", "candidate-2")
    sql = sql_for('app.post("/api/candidates/:candidateId/render"', "INSERT")

    inserted = db.execute(
        sql,
        (
            "clip-1", "job-1", "user-1", "candidate-1",
            "users/user-1/clips/clip-1.mp4", "Highlight 00:30",
            "No way, that was close!", 30.0,
            '{"captions":true,"resolution":"1080x1920"}',
        ),
    )
    assert inserted.rowcount == 1
    row = db.execute(
        "SELECT user_id,status,progress,aspect_ratio,output_key FROM clips WHERE id='clip-1'"
    ).fetchone()
    assert tuple(row) == ("user-1", "queued", 0, "9:16", "users/user-1/clips/clip-1.mp4")

    # A selected candidate is not renderable from a different authenticated account.
    wrong_owner = db.execute(
        sql,
        (
            "clip-friend", "job-2", "user-1", "candidate-2",
            "users/user-1/clips/clip-friend.mp4", "Friend highlight",
            "excerpt", 30.0, '{"captions":true,"resolution":"1080x1920"}',
        ),
    )
    assert wrong_owner.rowcount == 0

    db.execute("UPDATE candidates SET review_status='rejected' WHERE id='candidate-1'")
    not_selected = db.execute(
        sql,
        (
            "clip-rejected", "job-1", "user-1", "candidate-1",
            "users/user-1/clips/clip-rejected.mp4", "Rejected",
            "excerpt", 30.0, '{"captions":true,"resolution":"1080x1920"}',
        ),
    )
    assert not_selected.rowcount == 0


def test_clip_render_claim_is_owner_asset_and_selected_candidate_scoped() -> None:
    db = make_db()
    add_source_job(db, "job-1", "user-1", "asset-1", "candidate-1")
    db.execute(
        """
        INSERT INTO clips (id,job_id,user_id,candidate_id,output_key,title,duration_seconds,status)
        VALUES ('clip-1','job-1','user-1','candidate-1','users/user-1/clips/clip-1.mp4','Highlight',30,'queued')
        """
    )
    sql = sql_for('app.post("/internal/processor/render-claim"', "UPDATE clips SET status = 'rendering'")
    claimed = db.execute(sql, ("lease-1", "hash-1")).fetchone()
    assert claimed is not None
    assert claimed["id"] == "clip-1"
    row = db.execute(
        "SELECT status,attempt_count,lease_id,lease_token_hash FROM clips WHERE id='clip-1'"
    ).fetchone()
    assert tuple(row) == ("rendering", 1, "lease-1", "hash-1")


def test_clip_download_query_rejects_other_user_and_nonready_clip() -> None:
    db = make_db()
    add_source_job(db, "job-1", "user-1", "asset-1", "candidate-1")
    add_source_job(db, "job-2", "user-2", "asset-2", "candidate-2")
    for clip_id, job_id, user_id, status in (
        ("clip-1", "job-1", "user-1", "ready"),
        ("clip-2", "job-2", "user-2", "ready"),
        ("clip-3", "job-1", "user-1", "rendering"),
    ):
        db.execute(
            """
            INSERT INTO clips (id,job_id,user_id,candidate_id,output_key,title,status)
            VALUES (?,?,?,?,?,?,?)
            """,
            (clip_id, job_id, user_id, None, f"users/{user_id}/clips/{clip_id}.mp4", "clip", status),
        )
    query = sql_for('app.get("/api/clips/:clipId/download"', "SELECT")
    own = db.execute(query, ("clip-1", "user-1")).fetchone()
    friend = db.execute(query, ("clip-2", "user-1")).fetchone()
    pending = db.execute(query, ("clip-3", "user-1")).fetchone()
    assert own is not None
    assert friend is None
    assert pending is None
