-- Private clip render queue, leases and multipart output registration.
ALTER TABLE clips ADD COLUMN status TEXT NOT NULL DEFAULT 'queued'
  CHECK(status IN ('queued','rendering','ready','failed','cancelled'));
ALTER TABLE clips ADD COLUMN progress INTEGER NOT NULL DEFAULT 0
  CHECK(progress BETWEEN 0 AND 100);
ALTER TABLE clips ADD COLUMN error_code TEXT;
ALTER TABLE clips ADD COLUMN render_options_json TEXT NOT NULL DEFAULT '{"captions":true,"resolution":"1080x1920"}';
ALTER TABLE clips ADD COLUMN upload_id TEXT;
ALTER TABLE clips ADD COLUMN upload_size_bytes INTEGER
  CHECK(upload_size_bytes IS NULL OR upload_size_bytes BETWEEN 1 AND 536870912);
ALTER TABLE clips ADD COLUMN output_size_bytes INTEGER
  CHECK(output_size_bytes IS NULL OR output_size_bytes BETWEEN 1 AND 536870912);
ALTER TABLE clips ADD COLUMN lease_id TEXT;
ALTER TABLE clips ADD COLUMN lease_token_hash TEXT;
ALTER TABLE clips ADD COLUMN lease_expires_at TEXT;
ALTER TABLE clips ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0
  CHECK(attempt_count >= 0);
ALTER TABLE clips ADD COLUMN max_attempts INTEGER NOT NULL DEFAULT 3
  CHECK(max_attempts >= 1);
ALTER TABLE clips ADD COLUMN updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE clips ADD COLUMN completed_at TEXT;
ALTER TABLE clips ADD COLUMN cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK(cancel_requested IN (0,1));

CREATE UNIQUE INDEX IF NOT EXISTS idx_clips_candidate_unique
  ON clips(candidate_id) WHERE candidate_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clips_render_dispatch
  ON clips(status, created_at, lease_expires_at);

CREATE TABLE IF NOT EXISTS clip_output_parts (
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
  status TEXT NOT NULL CHECK(status IN ('uploading','uploaded')),
  etag TEXT,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(clip_id, part_number),
  CHECK(
    (status = 'uploading' AND etag IS NULL) OR
    (status = 'uploaded' AND etag IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_clip_output_parts_status
  ON clip_output_parts(clip_id, status, part_number);
