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
        "0007_transcription.sql",
        "0008_candidate_persistence.sql",
        "0009_clip_rendering.sql",
        "0010_clip_output_digest.sql",
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


def transcription_ready_sql() -> str:
    return route_sql("/internal/processor/transcription-ready", "UPDATE")


def transcription_ready_values(job_id: str = "job-1") -> tuple[object, ...]:
    return (
        "mov,mp4,m4a", "h264", "aac", 1920, 1080, 125.5,
        "pcm_s16le", 16000, 1, 4_000_044,
        "base", "en", 42, 12_345, "a" * 64,
        job_id, "lease-1", "hash-1",
    )


def test_transcription_ready_persists_media_and_transcript_metadata() -> None:
    db = make_db()
    add_asset(db, "asset-1", "user-1")
    add_job(db, "job-1", "user-1", "asset-1")
    result = db.execute(transcription_ready_sql(), transcription_ready_values()).fetchone()
    assert result is not None
    assert result["status"] == "processing"
    row = db.execute(
        """
        SELECT stage, progress, media_container, audio_size_bytes,
               transcript_model, transcript_language, transcript_segment_count,
               transcript_size_bytes, transcript_sha256, lease_id, lease_token_hash
        FROM jobs WHERE id = 'job-1'
        """
    ).fetchone()
    assert tuple(row) == (
        "transcribed", 60, "mov,mp4,m4a", 4_000_044,
        "base", "en", 42, 12_345, "a" * 64, "lease-1", "hash-1",
    )


def test_transcription_ready_rejects_stale_expired_cancelled_and_wrong_owner() -> None:
    db = make_db()
    add_asset(db, "asset-stale", "user-1")
    add_asset(db, "asset-expired", "user-1")
    add_asset(db, "asset-cancelled", "user-1")
    add_asset(db, "friend-asset", "user-2")
    add_job(db, "stale", "user-1", "asset-stale", lease_id="new-lease")
    add_job(db, "expired", "user-1", "asset-expired", lease_expiry="2000-01-01 00:00:00")
    add_job(db, "cancelled", "user-1", "asset-cancelled", cancel_requested=1)
    add_job(db, "wrong-owner", "user-1", "friend-asset")
    sql = transcription_ready_sql()

    for job_id in ("stale", "expired", "cancelled", "wrong-owner"):
        assert db.execute(sql, transcription_ready_values(job_id)).fetchone() is None


def moments_route_section() -> str:
    marker = 'app.post("/internal/processor/moments-ready"'
    return API_SOURCE.split(marker, 1)[1].split('\napp.post(', 1)[0]


def moments_sql(fragment: str) -> str:
    for line in moments_route_section().splitlines():
        match = re.search(r'^\s+"(.*)",\s*$', line)
        if match and fragment in match.group(1):
            return match.group(1)
    raise AssertionError(f"Could not find moments SQL containing {fragment!r}")


def set_transcript_ready(db: sqlite3.Connection, job_id: str = "job-1") -> None:
    db.execute(
        "UPDATE jobs SET transcript_verified_at = CURRENT_TIMESTAMP, media_duration_seconds = 125.5 WHERE id = ?",
        (job_id,),
    )


def moments_values(job_id: str = "job-1", generation_id: str = "a" * 32) -> tuple[object, ...]:
    return (generation_id, job_id, "lease-1", "hash-1")


def test_moments_callback_sql_persists_candidates_then_releases_lease() -> None:
    db = make_db()
    add_asset(db, "asset-1", "user-1")
    add_job(db, "job-1", "user-1", "asset-1")
    set_transcript_ready(db)

    generation_id = "a" * 32
    marker = db.execute(
        moments_sql("SET candidate_generation_id"),
        moments_values(generation_id=generation_id),
    )
    assert marker.rowcount == 1

    delete = db.execute(
        moments_sql("DELETE FROM candidates"),
        ("job-1", generation_id, "lease-1", "hash-1"),
    )
    assert delete.rowcount == 0

    insert = db.execute(
        moments_sql("INSERT INTO candidates"),
        (
            "candidate-1", "job-1", 12.0, 42.0, "No way, let's go!",
            91.0, generation_id, "audio energy change, reaction phrase",
            '{"acousticSalience":0.9,"transcriptVelocity":0.8,"narrativeArc":0.7,"novelty":0.6}',
            "lease-1", "hash-1",
        ),
    )
    assert insert.rowcount == 1

    finish = db.execute(
        moments_sql("stage = 'moments_detected'"),
        (generation_id, "job-1", "lease-1", "hash-1"),
    )
    assert finish.rowcount == 1

    row = db.execute(
        "SELECT status, stage, progress, candidate_generation_id, lease_id FROM jobs WHERE id = 'job-1'"
    ).fetchone()
    assert tuple(row) == ("review", "moments_detected", 75, generation_id, None)
    candidate = db.execute(
        "SELECT start_seconds, end_seconds, score, category, rationale, signals_json FROM candidates WHERE id = 'candidate-1'"
    ).fetchone()
    assert tuple(candidate) == (
        12.0, 42.0, 91.0, "unknown",
        "audio energy change, reaction phrase",
        '{"acousticSalience":0.9,"transcriptVelocity":0.8,"narrativeArc":0.7,"novelty":0.6}',
    )


def test_moment_candidate_insert_requires_current_owner_lease_and_transcript() -> None:
    db = make_db()
    add_asset(db, "asset-1", "user-1")
    add_asset(db, "friend-asset", "user-2")
    add_job(db, "job-1", "user-1", "asset-1")
    set_transcript_ready(db)
    insert = moments_sql("INSERT INTO candidates")
    generation_id = "b" * 32
    marker_update = db.execute(
        moments_sql("SET candidate_generation_id"),
        (generation_id, "job-1", "lease-1", "hash-1"),
    )
    assert marker_update.rowcount == 1
    values = (
        "candidate-1", "job-1", 12.0, 42.0, "excerpt", 90.0, generation_id,
        "reaction phrase", "{}", "lease-1", "hash-1",
    )
    assert db.execute(insert, values).rowcount == 1

    db.execute("DELETE FROM candidates")
    assert db.execute(insert, (*values[:1], *values[1:])).rowcount == 1
    db.execute("DELETE FROM candidates")
    assert db.execute(insert, ("stale", "job-1", 12.0, 42.0, "excerpt", 90.0, "b" * 32, "reason", "{}", "stale-lease", "hash-1")).rowcount == 0
    assert db.execute(insert, ("wrong-hash", "job-1", 12.0, 42.0, "excerpt", 90.0, "b" * 32, "reason", "{}", "lease-1", "wrong-hash")).rowcount == 0

    add_asset(db, "asset-3", "user-1")
    add_job(db, "job-no-transcript", "user-1", "asset-3")
    no_transcript = (
        "no-transcript", "job-no-transcript", 12.0, 42.0, "excerpt", 90.0,
        "b" * 32, "reason", "{}", "lease-1", "hash-1",
    )
    assert db.execute(insert, no_transcript).rowcount == 0


def test_candidate_list_query_is_scoped_to_authenticated_owner() -> None:
    db = make_db()
    add_asset(db, "asset-1", "user-1")
    add_asset(db, "asset-2", "user-2")
    add_job(db, "job-1", "user-1", "asset-1")
    add_job(db, "job-2", "user-2", "asset-2")
    db.execute(
        "INSERT INTO candidates (id, job_id, start_seconds, end_seconds, score) VALUES ('own', 'job-1', 1, 20, 80)"
    )
    db.execute(
        "INSERT INTO candidates (id, job_id, start_seconds, end_seconds, score) VALUES ('friend', 'job-2', 1, 20, 90)"
    )
    query = None
    for line in API_SOURCE.splitlines():
        match = re.search(
            r'^\s+"(SELECT candidates.id, candidates.start_seconds AS startSeconds.*FROM candidates.*)",\s*$',
            line,
        )
        if match:
            query = match.group(1)
            break
    assert query is not None
    own = db.execute(query, ("job-1", "user-1")).fetchall()
    wrong_owner = db.execute(query, ("job-2", "user-1")).fetchall()
    assert [row["id"] for row in own] == ["own"]
    assert wrong_owner == []
