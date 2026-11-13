ALTER TABLE clips ADD COLUMN size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes >= 0);

CREATE TABLE IF NOT EXISTS clip_uploads (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  upload_id TEXT,
  lease_id TEXT NOT NULL,
  expected_size_bytes INTEGER NOT NULL CHECK(expected_size_bytes > 0 AND expected_size_bytes <= 500000000),
  part_count INTEGER NOT NULL CHECK(part_count BETWEEN 1 AND 64),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 120),
  duration_seconds REAL NOT NULL CHECK(duration_seconds BETWEEN 5 AND 120),
  status TEXT NOT NULL CHECK(status IN ('uploading','stored','failed')) DEFAULT 'uploading',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id, candidate_id)
);

CREATE TABLE IF NOT EXISTS clip_upload_parts (
  clip_id TEXT NOT NULL REFERENCES clip_uploads(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 64),
  etag TEXT,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  status TEXT NOT NULL CHECK(status IN ('uploading','uploaded')) DEFAULT 'uploading',
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(clip_id, part_number)
);

CREATE INDEX IF NOT EXISTS idx_clip_uploads_job_status
  ON clip_uploads(job_id, status);
