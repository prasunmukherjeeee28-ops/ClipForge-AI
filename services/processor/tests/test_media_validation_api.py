from __future__ import annotations

import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
API_SOURCE = (ROOT / "apps/api/src/index.ts").read_text(encoding="utf-8")


def route_sql(route: str, prefix: str) -> str:
    marker = f'app.post("{route}"'
    section = API_SOURCE.split(marker, 1)[1].split("\napp.post(", 1)[0]
    match = re.search(r'^\s+"(' + re.escape(prefix) + r' [^"]+)",\s*$', section, re.MULTILINE)
    assert match, f"Could not find production {prefix} SQL for {route}"
    return match.group(1)


def make_db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    for migration in (
        "0001_initial.sql",
        "0002_processor_leases.sql",
        "0003_processor_request_nonces.sql",
        "0004_source_metadata.sql",
        "0005_authorized_source_assets.sql",
        "0006_media_validation.sql",
    ):
        db.executescript((ROOT / "database/migrations" / migration).read_text())
    db.executemany(
        "INSERT INTO users (id, auth_subject, email) VALUES (?, ?, ?)",
        [
            ("user-1", "subject-1", "one@example.com"),
            ("user-2", "subject-2", "two@example.com"),
        ],
    )
    return db


def add_asset(db: sqlite3.Connection, asset_id: str, user_id: str) -> None:
    db.execute(
        """
        INSERT INTO source_assets (
            id, user_id, object_key, filename, content_type, size_bytes, status
        ) VALUES (?, ?, ?, 'source.mp4', 'video/mp4', 1024, 'ready')
        """,
        (asset_id, user_id, f"source-assets/{user_id}/{asset_id}/source"),
    )


def add_job(
    db: sqlite3.Connection,
    job_id: str,
    user_id: str,
    asset_id: str,
    *,
    status: str = "processing",
    source_type: str = "video",
    lease_id: str = "lease-1",
    lease_hash: str = "hash-1",
    lease_expiry: str = "2999-01-01 00:00:00",
    cancel_requested: int = 0,
) -> None:
    db.execute(
        """
        INSERT INTO jobs (
            id, user_id, source_asset_id, source_url, source_platform, source_type,
            status, stage, lease_id, lease_token_hash, lease_expires_at, cancel_requested
        ) VALUES (?, ?, ?, 'https://youtu.be/dQw4w9WgXcQ', 'youtube', ?, ?, 'claimed', ?, ?, ?, ?)
        """,
        (job_id, user_id, asset_id, source_type, status, lease_id, lease_hash, lease_expiry, cancel_requested),
    )


def test_source_download_query_is_bound_to_current_owner_lease_and_ready_asset() -> None:
    db = make_db()
    add_asset(db, "asset-1", "user-1")
    add_asset(db, "asset-2", "user-2")
    add_job(db, "job-1", "user-1", "asset-1")
    add_job(db, "job-2", "user-2", "asset-2")
    query = route_sql("/internal/processor/source-asset", "SELECT")

    own = db.execute(query, ("job-1", "lease-1", "hash-1")).fetchone()
    assert own is not None
    assert own["objectKey"] == "source-assets/user-1/asset-1/source"
    assert own["sizeBytes"] == 1024

    other_job = db.execute(query, ("job-2", "lease-1", "hash-1")).fetchone()
    stale_lease = db.execute(query, ("job-1", "stale-lease", "hash-1")).fetchone()
    stale_hash = db.execute(query, ("job-1", "lease-1", "stale-hash")).fetchone()
    assert other_job is not None and other_job["filename"] == "source.mp4"
    assert stale_lease is None
    assert stale_hash is None


def test_source_download_query_rejects_expired_cancelled_or_nonready_assets() -> None:
    db = make_db()
    add_asset(db, "asset-1", "user-1")
    add_asset(db, "asset-2", "user-1")
    add_asset(db, "asset-3", "user-1")
    add_asset(db, "friend-asset", "user-2")
    add_job(db, "expired", "user-1", "asset-1", lease_expiry="2000-01-01 00:00:00")
    add_job(db, "cancelled", "user-1", "asset-2", cancel_requested=1)
    add_job(db, "deleting", "user-1", "asset-3")
    add_job(db, "wrong-owner", "user-1", "friend-asset")
    db.execute("UPDATE source_assets SET status = 'deleting' WHERE id = 'asset-3'")
    query = route_sql("/internal/processor/source-asset", "SELECT")
    assert db.execute(query, ("expired", "lease-1", "hash-1")).fetchone() is None
    assert db.execute(query, ("cancelled", "lease-1", "hash-1")).fetchone() is None
    assert db.execute(query, ("deleting", "lease-1", "hash-1")).fetchone() is None
    assert db.execute(query, ("wrong-owner", "lease-1", "hash-1")).fetchone() is None


def media_ready_sql() -> str:
    marker = 'app.post("/internal/processor/media-ready"'
    section = API_SOURCE.split(marker, 1)[1].split("\napp.post(", 1)[0]
    match = re.search(r'^\s+"(UPDATE jobs SET [^"]+)",\s*$', section, re.MULTILINE)
    assert match, "Could not find production media-ready UPDATE SQL"
    return match.group(1)


def media_ready_values(job_id: str = "job-1") -> tuple[object, ...]:
    return (
        "mov,mp4,m4a", "h264", "aac", 1920, 1080, 125.5,
        "pcm_s16le", 16000, 1, 4_000_044,
        job_id, "lease-1", "hash-1",
    )


def test_media_ready_callback_persists_validated_probe_and_audio_metadata() -> None:
    db = make_db()
    add_asset(db, "asset-1", "user-1")
    add_job(db, "job-1", "user-1", "asset-1")
    result = db.execute(media_ready_sql(), media_ready_values()).fetchone()
    assert result is not None
    assert result["status"] == "review"
    row = db.execute(
        """
        SELECT stage, progress, media_container, media_video_codec,
               media_source_audio_codec, media_width, media_height,
               media_duration_seconds, audio_codec, audio_sample_rate,
               audio_channels, audio_size_bytes, lease_id
        FROM jobs WHERE id = 'job-1'
        """
    ).fetchone()
    assert tuple(row) == (
        "audio_extracted", 35, "mov,mp4,m4a", "h264", "aac",
        1920, 1080, 125.5, "pcm_s16le", 16000, 1, 4_000_044, None,
    )


def test_media_ready_callback_rejects_stale_expired_cancelled_and_wrong_asset() -> None:
    db = make_db()
    add_asset(db, "asset-stale", "user-1")
    add_asset(db, "asset-expired", "user-1")
    add_asset(db, "asset-cancelled", "user-1")
    add_asset(db, "friend-asset", "user-2")
    add_job(db, "stale", "user-1", "asset-stale", lease_id="new-lease")
    add_job(db, "expired", "user-1", "asset-expired", lease_expiry="2000-01-01 00:00:00")
    add_job(db, "cancelled", "user-1", "asset-cancelled", cancel_requested=1)
    add_job(db, "wrong-owner", "user-1", "friend-asset")
    sql = media_ready_sql()

    for job_id in ("stale", "expired", "cancelled", "wrong-owner"):
        assert db.execute(sql, media_ready_values(job_id)).fetchone() is None
