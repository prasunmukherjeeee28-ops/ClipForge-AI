from __future__ import annotations

import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
API_SOURCE = (ROOT / "apps/api/src/index.ts").read_text(encoding="utf-8")


def route_update_sql(route: str) -> str:
    marker = f'app.post("/internal/processor/{route}"'
    section = API_SOURCE.split(marker, 1)[1].split("\napp.post(", 1)[0]
    match = re.search(r'^\s+"(UPDATE jobs SET [^"]+)",\s*$', section, re.MULTILINE)
    assert match, f"Could not find production UPDATE SQL for {route}"
    return match.group(1)


def make_db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.executescript((ROOT / "database/migrations/0001_initial.sql").read_text())
    db.executescript((ROOT / "database/migrations/0002_processor_leases.sql").read_text())
    db.execute(
        "INSERT INTO users (id, auth_subject, email) VALUES ('user-1', 'subject-1', 'one@example.com')"
    )
    db.execute(
        """
        INSERT INTO jobs (
            id, user_id, source_url, source_platform, status, stage,
            lease_id, lease_token_hash, lease_expires_at
        ) VALUES (
            'job-1', 'user-1', 'https://youtu.be/example', 'youtube', 'processing',
            'claimed', 'lease-old', 'hash-old', datetime('now', '-1 second')
        )
        """
    )
    return db


def test_expired_lease_cannot_heartbeat_progress_or_release() -> None:
    db = make_db()
    heartbeat = route_update_sql("heartbeat")
    progress = route_update_sql("progress")
    release = route_update_sql("release")

    heartbeat_result = db.execute(
        heartbeat, ("job-1", "lease-old", "hash-old")
    ).fetchone()
    progress_result = db.execute(
        progress, ("transcribing", 25, "job-1", "lease-old", "hash-old")
    )
    release_result = db.execute(release, ("job-1", "lease-old", "hash-old"))

    assert heartbeat_result is None
    assert progress_result.rowcount == 0
    assert release_result.rowcount == 0

    row = db.execute(
        "SELECT status, stage, lease_id, lease_token_hash FROM jobs WHERE id = 'job-1'"
    ).fetchone()
    assert tuple(row) == ("processing", "claimed", "lease-old", "hash-old")


def test_old_worker_cannot_mutate_job_after_reclaim() -> None:
    db = make_db()
    db.execute(
        """
        UPDATE jobs
        SET lease_id = 'lease-new', lease_token_hash = 'hash-new',
            lease_expires_at = datetime('now', '+90 seconds')
        WHERE id = 'job-1'
        """
    )

    heartbeat_result = db.execute(
        route_update_sql("heartbeat"), ("job-1", "lease-old", "hash-old")
    ).fetchone()
    progress_result = db.execute(
        route_update_sql("progress"),
        ("rendering", 80, "job-1", "lease-old", "hash-old"),
    )
    release_result = db.execute(
        route_update_sql("release"), ("job-1", "lease-old", "hash-old")
    )

    assert heartbeat_result is None
    assert progress_result.rowcount == 0
    assert release_result.rowcount == 0
    row = db.execute(
        "SELECT status, lease_id, lease_token_hash FROM jobs WHERE id = 'job-1'"
    ).fetchone()
    assert tuple(row) == ("processing", "lease-new", "hash-new")


def test_current_lease_owner_can_heartbeat_progress_and_release() -> None:
    db = make_db()
    db.execute(
        "UPDATE jobs SET lease_expires_at = datetime('now', '+90 seconds') WHERE id = 'job-1'"
    )

    heartbeat_result = db.execute(
        route_update_sql("heartbeat"), ("job-1", "lease-old", "hash-old")
    ).fetchone()
    progress_result = db.execute(
        route_update_sql("progress"),
        ("transcribing", 25, "job-1", "lease-old", "hash-old"),
    )
    release_result = db.execute(
        route_update_sql("release"), ("job-1", "lease-old", "hash-old")
    )

    assert heartbeat_result is not None
    assert progress_result.rowcount == 1
    assert release_result.rowcount == 1
    row = db.execute(
        "SELECT status, lease_id, lease_token_hash FROM jobs WHERE id = 'job-1'"
    ).fetchone()
    assert tuple(row) == ("queued", None, None)
