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
    db.executescript((ROOT / "database/migrations/0003_processor_request_nonces.sql").read_text())
    db.executescript((ROOT / "database/migrations/0004_source_metadata.sql").read_text())
    db.executescript((ROOT / "database/migrations/0005_authorized_source_assets.sql").read_text())
    db.executescript((ROOT / "database/migrations/0006_media_validation.sql").read_text())
    db.executescript((ROOT / "database/migrations/0007_transcription.sql").read_text())
    db.executescript((ROOT / "database/migrations/0008_moment_candidates.sql").read_text())
    db.executescript((ROOT / "database/migrations/0009_private_clip_storage.sql").read_text())
    db.executescript((ROOT / "database/migrations/0012_separate_source_modes.sql").read_text())
    db.executescript((ROOT / "database/migrations/0013_source_provider.sql").read_text())
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


def api_sql_containing(fragment: str) -> str:
    for line in API_SOURCE.splitlines():
        match = re.search(r'^\s+"(.*)",\s*$', line)
        if match and fragment in match.group(1):
            return match.group(1)
    raise AssertionError(f"Could not find SQL containing {fragment!r}")


def add_user_and_job(
    db: sqlite3.Connection, user_id: str, job_id: str, *, status: str = "queued",
    cancel_requested: int = 0, attempt_count: int = 0, max_attempts: int = 3,
    lease_expiry: str | None = None,
) -> None:
    db.execute(
        "INSERT OR IGNORE INTO users (id, auth_subject, email) VALUES (?, ?, ?)",
        (user_id, f"subject-{user_id}", f"{user_id}@example.com"),
    )
    db.execute(
        """
        INSERT INTO jobs (
            id, user_id, source_url, source_platform, status, cancel_requested,
            attempt_count, max_attempts, lease_expires_at
        ) VALUES (?, ?, ?, 'youtube', ?, ?, ?, ?, ?)
        """,
        (
            job_id, user_id, f"https://youtu.be/{job_id}", status,
            cancel_requested, attempt_count, max_attempts, lease_expiry,
        ),
    )


def test_claim_update_returns_distinct_jobs_for_sequential_workers() -> None:
    db = make_db()
    db.execute("UPDATE jobs SET status = 'queued', lease_id = NULL, lease_token_hash = NULL, lease_expires_at = NULL WHERE id = 'job-1'")
    add_user_and_job(db, "user-1", "job-2")
    for asset_id, job_id in (("asset-1", "job-1"), ("asset-2", "job-2")):
        db.execute(
            """
            INSERT INTO source_assets (
                id, user_id, object_key, filename, content_type, size_bytes, status
            ) VALUES (?, 'user-1', ?, 'source.mp4', 'video/mp4', 1024, 'ready')
            """,
            (asset_id, f"source-assets/user-1/{asset_id}/source"),
        )
        db.execute("UPDATE jobs SET source_asset_id = ? WHERE id = ?", (asset_id, job_id))

    claim_sql = api_sql_containing("UPDATE jobs SET status = 'processing'")
    first = db.execute(claim_sql, ("lease-1", "hash-1")).fetchone()
    second = db.execute(claim_sql, ("lease-2", "hash-2")).fetchone()

    assert first is not None
    assert second is not None
    assert first["id"] != second["id"]

    active_claims = db.execute(
        "SELECT id, lease_id FROM jobs WHERE status = 'processing'"
    ).fetchall()
    assert len(active_claims) == 2
    assert len({row["lease_id"] for row in active_claims}) == 2


def test_expired_jobs_recover_or_fail_at_attempt_limit() -> None:
    db = make_db()
    add_user_and_job(
        db, "user-1", "retry-job", status="processing",
        attempt_count=1, max_attempts=3, lease_expiry="2000-01-01 00:00:00",
    )
    add_user_and_job(
        db, "user-1", "exhausted-job", status="processing",
        attempt_count=3, max_attempts=3, lease_expiry="2000-01-01 00:00:00",
    )

    recover = api_sql_containing("error_code = 'lease_expired'")
    fail = api_sql_containing("error_code = 'retries_exhausted'")
    db.execute(fail)
    db.execute(recover)

    states = {
        row["id"]: (row["status"], row["error_code"], row["lease_id"])
        for row in db.execute(
            "SELECT id, status, error_code, lease_id FROM jobs WHERE id IN ('retry-job','exhausted-job')"
        )
    }
    assert states["retry-job"] == ("queued", "lease_expired", None)
    assert states["exhausted-job"] == ("failed", "retries_exhausted", None)


def test_expired_cancelled_job_becomes_cancelled_not_queued() -> None:
    db = make_db()
    add_user_and_job(
        db, "user-1", "cancelled-job", status="processing",
        cancel_requested=1, attempt_count=1, lease_expiry="2000-01-01 00:00:00",
    )
    recover_cancel = api_sql_containing("status = 'cancelled', stage = 'cancelled'")
    db.execute(recover_cancel)
    row = db.execute(
        "SELECT status, lease_id FROM jobs WHERE id = 'cancelled-job'"
    ).fetchone()
    assert tuple(row) == ("cancelled", None)


def test_cancel_endpoint_is_scoped_to_owning_user() -> None:
    db = make_db()
    add_user_and_job(db, "user-2", "friend-job")
    cancel_sql = api_sql_containing("SET cancel_requested = 1")
    result = db.execute(cancel_sql, ("friend-job", "user-1"))
    assert result.rowcount == 0
    row = db.execute(
        "SELECT status, cancel_requested FROM jobs WHERE id = 'friend-job'"
    ).fetchone()
    assert tuple(row) == ("queued", 0)


def test_job_list_query_is_scoped_to_authenticated_user() -> None:
    db = make_db()
    add_user_and_job(db, "user-2", "friend-job")
    list_sql = api_sql_containing("SELECT id, source_url AS sourceUrl")
    rows = db.execute(list_sql, ("user-1", 100)).fetchall()
    assert {row["id"] for row in rows} == {"job-1"}



def test_failure_callback_requires_current_unexpired_lease() -> None:
    db = make_db()
    db.execute(
        "UPDATE jobs SET lease_expires_at = datetime('now', '+90 seconds') WHERE id = 'job-1'"
    )
    fail = route_update_sql("fail")

    stale_result = db.execute(
        fail, ("source_unavailable", "job-1", "lease-old", "hash-wrong")
    )
    assert stale_result.rowcount == 0

    valid_result = db.execute(
        fail, ("source_unavailable", "job-1", "lease-old", "hash-old")
    ).fetchone()
    assert valid_result is not None
    assert valid_result["status"] == "failed"
    row = db.execute(
        "SELECT status, stage, error_code, lease_id, lease_token_hash FROM jobs WHERE id = 'job-1'"
    ).fetchone()
    assert tuple(row) == ("failed", "failed", "source_unavailable", None, None)


def test_failure_callback_acknowledges_cancellation_without_marking_failed() -> None:
    db = make_db()
    db.execute(
        "UPDATE jobs SET lease_expires_at = datetime('now', '+90 seconds'), cancel_requested = 1 WHERE id = 'job-1'"
    )
    result = db.execute(
        route_update_sql("fail"),
        ("processing_error", "job-1", "lease-old", "hash-old"),
    ).fetchone()
    assert result is not None
    assert result["status"] == "cancelled"
    row = db.execute(
        "SELECT status, stage, error_code, lease_id FROM jobs WHERE id = 'job-1'"
    ).fetchone()
    assert tuple(row) == ("cancelled", "cancelled", None, None)



def test_processor_request_nonce_is_single_use() -> None:
    db = make_db()
    first = db.execute(
        "INSERT INTO processor_request_nonces (nonce_hash) VALUES (?) ON CONFLICT(nonce_hash) DO NOTHING",
        ("nonce-hash",),
    )
    replay = db.execute(
        "INSERT INTO processor_request_nonces (nonce_hash) VALUES (?) ON CONFLICT(nonce_hash) DO NOTHING",
        ("nonce-hash",),
    )
    assert first.rowcount == 1
    assert replay.rowcount == 0



def test_completion_callback_requires_current_unexpired_lease() -> None:
    db = make_db()
    complete = route_update_sql("complete")

    # Expired lease cannot complete the job.
    expired = db.execute(
        complete, ("Final stream title", "job-1", "lease-old", "hash-old")
    )
    assert expired.rowcount == 0

    db.execute(
        "UPDATE jobs SET lease_expires_at = datetime('now', '+90 seconds') WHERE id = 'job-1'"
    )
    completed = db.execute(
        complete, ("Final stream title", "job-1", "lease-old", "hash-old")
    )
    assert completed.rowcount == 1
    row = db.execute(
        "SELECT status, stage, progress, title, lease_id, lease_token_hash, completed_at FROM jobs WHERE id = 'job-1'"
    ).fetchone()
    assert tuple(row[:6]) == (
        "completed", "completed", 100, "Final stream title", None, None
    )
    assert row["completed_at"] is not None


def test_completion_callback_cannot_override_cancellation() -> None:
    db = make_db()
    db.execute(
        "UPDATE jobs SET lease_expires_at = datetime('now', '+90 seconds'), cancel_requested = 1 WHERE id = 'job-1'"
    )
    result = db.execute(
        route_update_sql("complete"),
        ("Should not finish", "job-1", "lease-old", "hash-old"),
    )
    assert result.rowcount == 0
    row = db.execute(
        "SELECT status, cancel_requested FROM jobs WHERE id = 'job-1'"
    ).fetchone()
    assert tuple(row) == ("processing", 1)



def test_job_detail_query_hides_another_users_job() -> None:
    db = make_db()
    add_user_and_job(db, "user-2", "friend-job")
    detail_sql = api_sql_containing("FROM jobs WHERE id = ?1 AND user_id = ?2")
    row = db.execute(detail_sql, ("friend-job", "user-1")).fetchone()
    assert row is None


def test_clip_list_query_hides_another_users_clips() -> None:
    db = make_db()
    add_user_and_job(db, "user-2", "friend-job")
    db.execute(
        "INSERT INTO clips (id, job_id, user_id, output_key, title) VALUES (?, ?, ?, ?, ?)",
        ("clip-owner", "job-1", "user-1", "users/user-1/clips/clip-owner.mp4", "Mine"),
    )
    db.execute(
        "INSERT INTO clips (id, job_id, user_id, output_key, title) VALUES (?, ?, ?, ?, ?)",
        ("clip-friend", "friend-job", "user-2", "users/user-2/clips/clip-friend.mp4", "Friend"),
    )
    clips_sql = api_sql_containing("SELECT id, job_id AS jobId, title, description")
    rows = db.execute(clips_sql, ("user-1",)).fetchall()
    assert {row["id"] for row in rows} == {"clip-owner"}



def test_clip_preview_lookup_is_scoped_to_authenticated_user() -> None:
    db = make_db()
    add_user_and_job(db, "user-2", "friend-job")
    db.execute(
        "INSERT INTO clips (id, job_id, user_id, output_key, title) VALUES (?, ?, ?, ?, ?)",
        ("clip-owner", "job-1", "user-1", "users/user-1/clips/clip-owner.mp4", "Mine"),
    )
    db.execute(
        "INSERT INTO clips (id, job_id, user_id, output_key, title) VALUES (?, ?, ?, ?, ?)",
        ("clip-friend", "friend-job", "user-2", "users/user-2/clips/clip-friend.mp4", "Friend"),
    )
    preview_sql = api_sql_containing(
        "SELECT output_key AS outputKey FROM clips WHERE id = ?1 AND user_id = ?2"
    )
    assert db.execute(preview_sql, ("clip-owner", "user-1")).fetchone() is not None
    assert db.execute(preview_sql, ("clip-friend", "user-1")).fetchone() is None


def test_cancel_all_query_only_marks_authenticated_users_jobs() -> None:
    db = make_db()
    add_user_and_job(db, "user-1", "own-queued-job")
    add_user_and_job(db, "user-2", "friend-queued-job")
    cancel_all_sql = api_sql_containing(
        "WHERE user_id = ?1 AND (status IN ('queued','processing') OR (status = 'review' AND stage = 'awaiting_source_asset'))"
    )
    db.execute(cancel_all_sql, ("user-1",))
    states = {
        row["id"]: row["cancel_requested"]
        for row in db.execute(
            "SELECT id, cancel_requested FROM jobs WHERE id IN ('own-queued-job','friend-queued-job')"
        )
    }
    assert states == {"own-queued-job": 1, "friend-queued-job": 0}
