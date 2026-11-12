from __future__ import annotations

import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
API_SOURCE = (ROOT / "apps/api/src/index.ts").read_text(encoding="utf-8")


def source_metadata_sql() -> str:
    marker = 'app.post("/internal/processor/source-metadata"'
    section = API_SOURCE.split(marker, 1)[1].split("\napp.post(", 1)[0]
    match = re.search(r'^\s+"(UPDATE jobs SET [^"]+)",\s*$', section, re.MULTILINE)
    assert match, "Could not find production source metadata UPDATE SQL"
    return match.group(1)


def make_db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.executescript((ROOT / "database/migrations/0001_initial.sql").read_text())
    db.executescript((ROOT / "database/migrations/0002_processor_leases.sql").read_text())
    db.executescript((ROOT / "database/migrations/0003_processor_request_nonces.sql").read_text())
    db.executescript((ROOT / "database/migrations/0004_source_metadata.sql").read_text())
    db.execute(
        "INSERT INTO users (id, auth_subject, email) VALUES ('user-1', 'subject-1', 'one@example.com')"
    )
    db.execute(
        """
        INSERT INTO jobs (
            id, user_id, source_url, source_platform, status, stage,
            lease_id, lease_token_hash, lease_expires_at
        ) VALUES (
            'job-1', 'user-1', 'https://youtu.be/dQw4w9WgXcQ', 'youtube', 'processing',
            'claimed', 'lease-1', 'hash-1', datetime('now', '+90 seconds')
        )
        """
    )
    return db


def payload(
    *, token_hash: str = "hash-1", job_id: str = "job-1", lease_id: str = "lease-1",
    source_type: str = "video", source_id: str = "dQw4w9WgXcQ",
    title: str = "Test VOD", duration: int | None = 3600,
    published_at: str | None = "2026-01-01T00:00:00Z",
) -> tuple[object, ...]:
    # Exact bind order in the production SQL after lease-token hashing.
    return (
        source_type, source_id, title, duration, published_at,
        job_id, lease_id, token_hash, "youtube",
    )


def test_current_lease_can_persist_source_metadata() -> None:
    db = make_db()
    result = db.execute(source_metadata_sql(), payload())
    assert result.rowcount == 1
    row = db.execute(
        """
        SELECT source_type, source_id, title, source_duration_seconds,
               source_published_at, source_verified_at, stage, progress
        FROM jobs WHERE id = 'job-1'
        """
    ).fetchone()
    assert row[:7] == (
        "video", "dQw4w9WgXcQ", "Test VOD", 3600,
        "2026-01-01T00:00:00Z", row[5], "source_metadata_verified",
    )
    assert row[5] is not None
    assert row[7] == 5


def test_expired_lease_cannot_persist_source_metadata() -> None:
    db = make_db()
    db.execute("UPDATE jobs SET lease_expires_at = datetime('now', '-1 second') WHERE id = 'job-1'")
    result = db.execute(source_metadata_sql(), payload())
    assert result.rowcount == 0


def test_replaced_lease_cannot_persist_source_metadata() -> None:
    db = make_db()
    db.execute(
        "UPDATE jobs SET lease_id = 'lease-new', lease_token_hash = 'hash-new', "
        "lease_expires_at = datetime('now', '+90 seconds') WHERE id = 'job-1'"
    )
    stale = db.execute(source_metadata_sql(), payload()).rowcount
    assert stale == 0


def test_cancelled_job_cannot_persist_source_metadata() -> None:
    db = make_db()
    db.execute("UPDATE jobs SET cancel_requested = 1 WHERE id = 'job-1'")
    result = db.execute(source_metadata_sql(), payload())
    assert result.rowcount == 0
