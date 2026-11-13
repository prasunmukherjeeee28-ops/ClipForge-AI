-- Bind resumable clip output uploads to the exact rendered MP4 content.
ALTER TABLE clips ADD COLUMN output_sha256 TEXT
  CHECK(output_sha256 IS NULL OR length(output_sha256) = 64);
