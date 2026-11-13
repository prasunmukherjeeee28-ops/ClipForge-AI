-- Store transcript verification metadata; transcript content stays on private processor scratch.
ALTER TABLE jobs ADD COLUMN transcript_model TEXT;
ALTER TABLE jobs ADD COLUMN transcript_language TEXT;
ALTER TABLE jobs ADD COLUMN transcript_segment_count INTEGER
  CHECK(transcript_segment_count IS NULL OR transcript_segment_count BETWEEN 0 AND 500000);
ALTER TABLE jobs ADD COLUMN transcript_size_bytes INTEGER
  CHECK(transcript_size_bytes IS NULL OR transcript_size_bytes BETWEEN 2 AND 100000000);
ALTER TABLE jobs ADD COLUMN transcript_sha256 TEXT
  CHECK(transcript_sha256 IS NULL OR length(transcript_sha256) = 64);
ALTER TABLE jobs ADD COLUMN transcript_verified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_transcript_stage
  ON jobs(status, stage, transcript_verified_at);
