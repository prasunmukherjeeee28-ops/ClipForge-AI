-- Separate public-link imports from direct private file uploads.
-- Existing jobs default to upload mode because the previous workflow required a ready source asset.
ALTER TABLE jobs ADD COLUMN source_mode TEXT NOT NULL DEFAULT 'upload'
  CHECK(source_mode IN ('url', 'upload'));

-- Record the authenticated user's confirmation that they own the source or have permission to process it.
ALTER TABLE jobs ADD COLUMN source_authorized_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_mode_queue
  ON jobs(source_mode, status, created_at);
