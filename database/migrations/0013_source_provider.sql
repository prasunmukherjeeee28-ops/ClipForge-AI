-- Store a normalized source provider without widening the legacy source_platform CHECK constraint.
ALTER TABLE jobs ADD COLUMN source_provider TEXT NOT NULL DEFAULT 'youtube'
  CHECK(source_provider IN ('youtube', 'twitch', 'kick'));

-- Preserve provider values for jobs created before this migration.
UPDATE jobs SET source_provider = source_platform;

CREATE INDEX IF NOT EXISTS idx_jobs_provider_queue
  ON jobs(source_provider, status, created_at);
