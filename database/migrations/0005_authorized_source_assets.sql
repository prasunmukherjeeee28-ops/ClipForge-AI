-- Creator-authorized source-file uploads, stored privately in R2.
CREATE TABLE IF NOT EXISTS source_assets (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL CHECK(length(filename) BETWEEN 1 AND 200),
  content_type TEXT NOT NULL CHECK(content_type IN (
    'video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska'
  )),
  size_bytes INTEGER NOT NULL CHECK(size_bytes BETWEEN 1 AND 2147483648),
  status TEXT NOT NULL DEFAULT 'uploading'
    CHECK(status IN ('uploading', 'ready', 'failed')),
  upload_id TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TEXT,
  CHECK(
    (status = 'uploading' AND upload_id IS NOT NULL) OR
    (status <> 'uploading' AND upload_id IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS source_asset_parts (
  asset_id TEXT NOT NULL REFERENCES source_assets(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK(part_number BETWEEN 1 AND 10000),
  status TEXT NOT NULL CHECK(status IN ('uploading', 'uploaded')),
  etag TEXT,
  size_bytes INTEGER NOT NULL CHECK(size_bytes > 0),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(asset_id, part_number),
  CHECK(
    (status = 'uploading' AND etag IS NULL) OR
    (status = 'uploaded' AND etag IS NOT NULL)
  )
);

ALTER TABLE jobs ADD COLUMN source_asset_id TEXT
  REFERENCES source_assets(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_source_asset_unique
  ON jobs(source_asset_id) WHERE source_asset_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_source_assets_user_created
  ON source_assets(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_source_assets_user_status
  ON source_assets(user_id, status);
CREATE INDEX IF NOT EXISTS idx_source_asset_parts_asset_status
  ON source_asset_parts(asset_id, status, part_number);
