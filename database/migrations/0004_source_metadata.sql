ALTER TABLE jobs ADD COLUMN source_id TEXT;
ALTER TABLE jobs ADD COLUMN source_duration_seconds INTEGER
  CHECK(source_duration_seconds IS NULL OR source_duration_seconds BETWEEN 0 AND 604800);
ALTER TABLE jobs ADD COLUMN source_published_at TEXT;
ALTER TABLE jobs ADD COLUMN source_verified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_source_verified
  ON jobs(source_verified_at);
