ALTER TABLE jobs ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count >= 0);
ALTER TABLE jobs ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3 CHECK(max_attempts >= 1);
ALTER TABLE jobs ADD COLUMN lease_id TEXT;
ALTER TABLE jobs ADD COLUMN lease_token_hash TEXT;
ALTER TABLE jobs ADD COLUMN lease_expires_at TEXT;
ALTER TABLE jobs ADD COLUMN last_heartbeat_at TEXT;
ALTER TABLE jobs ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1));

CREATE INDEX IF NOT EXISTS idx_jobs_dispatch ON jobs(status, cancel_requested, created_at);
CREATE INDEX IF NOT EXISTS idx_jobs_lease_expiry ON jobs(status, lease_expires_at);
