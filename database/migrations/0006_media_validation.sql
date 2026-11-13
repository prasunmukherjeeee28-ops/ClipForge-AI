-- Persist probed source metadata and the normalized local audio artifact metadata.
ALTER TABLE jobs ADD COLUMN media_container TEXT;
ALTER TABLE jobs ADD COLUMN media_video_codec TEXT;
ALTER TABLE jobs ADD COLUMN media_source_audio_codec TEXT;
ALTER TABLE jobs ADD COLUMN media_width INTEGER CHECK(media_width IS NULL OR media_width BETWEEN 1 AND 7680);
ALTER TABLE jobs ADD COLUMN media_height INTEGER CHECK(media_height IS NULL OR media_height BETWEEN 1 AND 4320);
ALTER TABLE jobs ADD COLUMN media_duration_seconds REAL CHECK(media_duration_seconds IS NULL OR (media_duration_seconds > 0 AND media_duration_seconds <= 43200));
ALTER TABLE jobs ADD COLUMN audio_codec TEXT;
ALTER TABLE jobs ADD COLUMN audio_sample_rate INTEGER CHECK(audio_sample_rate IS NULL OR audio_sample_rate = 16000);
ALTER TABLE jobs ADD COLUMN audio_channels INTEGER CHECK(audio_channels IS NULL OR audio_channels = 1);
ALTER TABLE jobs ADD COLUMN audio_size_bytes INTEGER CHECK(audio_size_bytes IS NULL OR audio_size_bytes BETWEEN 1 AND 1500000000);
ALTER TABLE jobs ADD COLUMN media_verified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_jobs_media_stage
  ON jobs(status, stage, media_verified_at);
