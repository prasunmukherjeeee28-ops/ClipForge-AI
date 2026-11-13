from __future__ import annotations

import re
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
API_SOURCE = (ROOT / "apps/api/src/index.ts").read_text(encoding="utf-8")


def production_update_sql(route: str) -> str:
    marker = f'app.post("{route}"'
    section = API_SOURCE.split(marker, 1)[1]
    match = re.search(r'^\s+"(UPDATE jobs SET [^"]+)",\s*$', section, re.MULTILINE)
    assert match, f"Could not find production update SQL for {route}"
    return match.group(1)


def api_sql_containing(fragment: str) -> str:
    for line in API_SOURCE.splitlines():
        match = re.search(r'^\s+"(.*)",\s*$', line)
        if match and fragment in match.group(1):
            return match.group(1)
    raise AssertionError(f"Could not find SQL containing {fragment!r}")


def make_db() -> sqlite3.Connection:
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    for migration in (
        "0001_initial.sql",
        "0002_processor_leases.sql",
        "0003_processor_request_nonces.sql",
        "0004_source_metadata.sql",
        "0005_authorized_source_assets.sql",
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


def add_asset(
    db: sqlite3.Connection,
    asset_id: str,
    user_id: str,
    *,
    status: str = "ready",
) -> None:
    upload_id = "multipart-upload" if status == "uploading" else None
    db.execute(
        """
        INSERT INTO source_assets (
            id, user_id, object_key, filename, content_type,
            size_bytes, status, upload_id
        ) VALUES (?, ?, ?, 'source.mp4', 'video/mp4', 1024, ?, ?)
        """,
        (asset_id, user_id, f"source-assets/{user_id}/{asset_id}/source", status, upload_id),
    )


def add_job(
    db: sqlite3.Connection,
    job_id: str,
    user_id: str,
    *,
    status: str = "review",
    stage: str = "awaiting_source_asset",
    source_asset_id: str | None = None,
    source_type: str = "unknown",
    lease_id: str | None = None,
    lease_hash: str | None = None,
    lease_expiry: str | None = None,
) -> None:
    db.execute(
        """
        INSERT INTO jobs (
            id, user_id, source_url, source_platform, source_type,
            status, stage, source_asset_id, lease_id, lease_token_hash,
            lease_expires_at
        ) VALUES (?, ?, ?, 'youtube', ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            job_id, user_id, f"https://youtu.be/{job_id}", source_type,
            status, stage, source_asset_id, lease_id, lease_hash, lease_expiry,
        ),
    )


def test_job_attachment_requires_asset_owned_by_same_user_and_ready() -> None:
    db = make_db()
    add_asset(db, "friend-asset", "user-2")
    add_asset(db, "own-asset", "user-1")
    add_job(db, "job-1", "user-1")
    attach = production_update_sql("/api/jobs/:jobId/source-asset")

    cross_user = db.execute(attach, ("friend-asset", "job-1", "user-1"))
    assert cross_user.rowcount == 0

    own_asset = db.execute(attach, ("own-asset", "job-1", "user-1"))
    assert own_asset.rowcount == 1
    row = db.execute(
        "SELECT source_asset_id, status, stage FROM jobs WHERE id = 'job-1'"
    ).fetchone()
    assert tuple(row) == ("own-asset", "queued", "queued")


def test_one_source_asset_cannot_be_attached_to_two_jobs() -> None:
    db = make_db()
    add_asset(db, "asset-1", "user-1")
    add_job(db, "job-1", "user-1", status="queued", stage="queued", source_asset_id="asset-1")
    add_job(db, "job-2", "user-1")
    attach = production_update_sql("/api/jobs/:jobId/source-asset")

    result = db.execute(attach, ("asset-1", "job-2", "user-1"))
    assert result.rowcount == 0
    row = db.execute(
        "SELECT source_asset_id, status FROM jobs WHERE id = 'job-2'"
    ).fetchone()
    assert tuple(row) == (None, "review")


def test_worker_claims_only_jobs_with_a_ready_asset() -> None:
    db = make_db()
    add_asset(db, "ready-asset", "user-1")
    add_asset(db, "uploading-asset", "user-1", status="uploading")
    add_job(db, "waiting-job", "user-1", status="queued", stage="queued")
    add_job(
        db, "uploading-job", "user-1", status="queued", stage="queued",
        source_asset_id="uploading-asset",
    )
    add_job(
        db, "ready-job", "user-1", status="queued", stage="queued",
        source_asset_id="ready-asset",
    )

    claim = api_sql_containing("UPDATE jobs SET status = 'processing'")
    first = db.execute(claim, ("lease-1", "hash-1")).fetchone()
    assert first is not None
    assert first["id"] == "ready-job"
    second = db.execute(claim, ("lease-2", "hash-2")).fetchone()
    assert second is None


def test_source_ready_callback_requires_current_lease_and_ready_asset() -> None:
    db = make_db()
    add_asset(db, "asset-1", "user-1")
    add_job(
        db, "job-1", "user-1", status="processing", stage="source_metadata_verified",
        source_asset_id="asset-1", source_type="video", lease_id="lease-1",
        lease_hash="hash-1", lease_expiry="2999-01-01 00:00:00",
    )
    update = production_update_sql("/internal/processor/source-ready")
    result = db.execute(update, ("job-1", "lease-1", "hash-1")).fetchone()
    assert result is not None
    assert result["status"] == "review"

    row = db.execute(
        "SELECT status, stage, lease_id, lease_token_hash FROM jobs WHERE id = 'job-1'"
    ).fetchone()
    assert tuple(row) == ("review", "source_ready", None, None)


def test_source_asset_listing_is_scoped_to_authenticated_user() -> None:
    db = make_db()
    add_asset(db, "own-asset", "user-1")
    add_asset(db, "friend-asset", "user-2")
    query = api_sql_containing("FROM source_assets WHERE user_id = ?1 ORDER BY created_at DESC")
    rows = db.execute(query, ("user-1",)).fetchall()
    assert {row["id"] for row in rows} == {"own-asset"}


def test_multipart_parts_are_unique_per_asset_and_part_number() -> None:
    db = make_db()
    add_asset(db, "asset-1", "user-1")
    insert = """
        INSERT INTO source_asset_parts (asset_id, part_number, status, etag, size_bytes)
        VALUES ('asset-1', 1, 'uploaded', 'etag-1', 8388608)
    """
    db.execute(insert)
    try:
        db.execute(insert.replace("'etag-1'", "'etag-2'"))
    except sqlite3.IntegrityError:
        pass
    else:
        raise AssertionError("duplicate multipart part number was accepted")

def source_asset_delete_reservation_sql() -> str:
    marker = 'app.delete("/api/source-assets/:assetId"'
    section = API_SOURCE.split(marker, 1)[1]
    match = re.search(r'^\s+"(UPDATE source_assets SET [^"]+)",\s*$', section, re.MULTILINE)
    assert match, "Could not find atomic source asset delete reservation SQL"
    return match.group(1)


def test_delete_reservation_closes_attach_delete_race() -> None:
    # Deletion wins first: status changes atomically, so later attachment fails.
    db = make_db()
    add_asset(db, "asset-1", "user-1")
    add_job(db, "job-1", "user-1")
    reserve_delete = source_asset_delete_reservation_sql()
    reserved = db.execute(reserve_delete, ("asset-1", "user-1")).fetchone()
    assert reserved is not None
    assert reserved["objectKey"] == "source-assets/user-1/asset-1/source"

    attach = production_update_sql("/api/jobs/:jobId/source-asset")
    attached = db.execute(attach, ("asset-1", "job-1", "user-1"))
    assert attached.rowcount == 0
    assert db.execute(
        "SELECT status FROM source_assets WHERE id = 'asset-1'"
    ).fetchone()["status"] == "deleting"

    # Attachment wins first: deletion cannot reserve the attached active asset.
    db = make_db()
    add_asset(db, "asset-2", "user-1")
    add_job(db, "job-2", "user-1")
    attached = db.execute(attach, ("asset-2", "job-2", "user-1"))
    assert attached.rowcount == 1
    reserved = db.execute(reserve_delete, ("asset-2", "user-1")).fetchone()
    assert reserved is None


def test_delete_reservation_waits_for_inflight_upload_parts_and_finalization() -> None:
    db = make_db()
    add_asset(db, "asset-1", "user-1", status="uploading")
    db.execute(
        """
        INSERT INTO source_asset_parts (asset_id, part_number, status, etag, size_bytes)
        VALUES ('asset-1', 1, 'uploading', NULL, 8388608)
        """
    )
    reserve_delete = source_asset_delete_reservation_sql()
    blocked = db.execute(reserve_delete, ("asset-1", "user-1")).fetchone()
    assert blocked is None

    db.execute(
        "UPDATE source_asset_parts SET status = 'uploaded', etag = 'etag-1' WHERE asset_id = 'asset-1'"
    )
    allowed = db.execute(reserve_delete, ("asset-1", "user-1")).fetchone()
    assert allowed is not None
    row = db.execute(
        "SELECT status, upload_id FROM source_assets WHERE id = 'asset-1'"
    ).fetchone()
    assert tuple(row) == ("deleting", "multipart-upload")


def test_finalizing_asset_cannot_be_reserved_for_deletion() -> None:
    db = make_db()
    db.execute(
        """
        INSERT INTO source_assets (
            id, user_id, object_key, filename, content_type, size_bytes, status, upload_id
        ) VALUES (
            'asset-finalizing', 'user-1', 'source-assets/user-1/finalizing/source',
            'source.mp4', 'video/mp4', 1024, 'finalizing', 'multipart-finalizing'
        )
        """
    )
    reserve_delete = source_asset_delete_reservation_sql()
    result = db.execute(
        reserve_delete, ("asset-finalizing", "user-1")
    ).fetchone()
    assert result is None
    assert db.execute(
        "SELECT status FROM source_assets WHERE id = 'asset-finalizing'"
    ).fetchone()["status"] == "finalizing"

def test_part_reservation_requires_owned_asset_still_uploading() -> None:
    db = make_db()
    add_asset(db, "asset-uploading", "user-1", status="uploading")
    add_asset(db, "asset-ready", "user-1")
    add_asset(db, "asset-friend", "user-2", status="uploading")
    reserve_part = api_sql_containing("INSERT INTO source_asset_parts")

    own_upload = db.execute(
        reserve_part, ("asset-uploading", 1, 8388608, "user-1")
    )
    assert own_upload.rowcount == 1

    db.execute(
        "UPDATE source_assets SET status = 'deleting' WHERE id = 'asset-ready'"
    )
    deleting = db.execute(
        reserve_part, ("asset-ready", 1, 8388608, "user-1")
    )
    assert deleting.rowcount == 0

    cross_user = db.execute(
        reserve_part, ("asset-friend", 1, 8388608, "user-1")
    )
    assert cross_user.rowcount == 0
