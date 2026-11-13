-- Canonical fresh-install schema. Apply through database/migrations/0001_initial.sql.
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  auth_subject TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS source_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 200),
  content_type TEXT NOT NULL CHECK(content_type IN ('video/mp4','video/quicktime','video/webm','video/x-matroska')),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 2147483648),
  status TEXT NOT NULL DEFAULT 'uploading' CHECK(status IN ('uploading','finalizing','ready','failed','deleting')),
  upload_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  CHECK(
    (status IN ('uploading','finalizing') AND upload_id IS NOT NULL) OR
    (status IN ('ready','failed') AND upload_id IS NULL) OR
    status = 'deleting'
  )
);

CREATE TABLE IF NOT EXISTS source_asset_parts (
  asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
  status TEXT NOT NULL CHECK(status IN ('uploading','uploaded')),
  etag TEXT,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(asset_id, part_number),
  CHECK(
    (status = 'uploading' AND etag IS NULL) OR
    (status = 'uploaded' AND etag IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_asset_id TEXT REFERENCES source_assets(id) ON DELETE SET NULL,
  source_url TEXT NOT NULL,
  source_platform TEXT NOT NULL CHECK(source_platform IN ('youtube','twitch')),
  source_type TEXT NOT NULL DEFAULT 'unknown' CHECK(source_type IN ('unknown','live','video')),
  title TEXT,
  status TEXT NOT NULL CHECK(status IN ('queued','processing','review','completed','failed','cancelled')) DEFAULT 'queued',
  progress INTEGER NOT NULL DEFAULT 0 CHECK(progress BETWEEN 0 AND 100),
  stage TEXT NOT NULL DEFAULT 'queued',
  options_json TEXT NOT NULL DEFAULT '{}',
  error_code TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  started_at TEXT,
  completed_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts >= 1),
  lease_id TEXT,
  lease_token_hash TEXT,
  lease_expires_at TEXT,
  last_heartbeat_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1))
);

CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  start_seconds REAL NOT NULL CHECK(start_seconds >= 0),
  end_seconds REAL NOT NULL CHECK(end_seconds > start_seconds),
  title TEXT,
  transcript_excerpt TEXT,
  score REAL CHECK(score IS NULL OR (score >= 0 AND score <= 100)),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK(review_status IN ('pending','selected','rejected')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS clips (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  candidate_id TEXT REFERENCES candidates(id) ON DELETE SET NULL,
  output_key TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  hashtags_json TEXT NOT NULL DEFAULT '[]',
  duration_seconds REAL,
  aspect_ratio TEXT NOT NULL DEFAULT '9:16',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_jobs_user_created ON jobs(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs(user_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_asset_unique
  ON jobs(source_asset_id) WHERE source_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_source_assets_user_created
  ON source_assets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_assets_user_status
  ON source_assets(user_id, status);
CREATE INDEX IF NOT EXISTS idx_source_asset_parts_asset_status
  ON source_asset_parts(asset_id, status, part_number);
CREATE INDEX IF NOT EXISTS idx_jobs_dispatch ON jobs(status, cancel_requested, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease_expiry ON jobs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_candidates_job ON candidates(job_id);
CREATE INDEX IF NOT EXISTS idx_clips_user_created ON clips(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_clips_job ON clips(job_id);

CREATE TABLE IF NOT EXISTS processor_request_nonces (
  nonce_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_processor_nonces_created
  ON processor_request_nonces(created_at);
