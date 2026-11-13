CREATE TABLE IF NOT EXISTS moment_candidates (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  start_seconds REAL NOT NULL CHECK(start_seconds >= 0),
  end_seconds REAL NOT NULL CHECK(end_seconds > start_seconds),
  score REAL NOT NULL CHECK(score >= 0 AND score <= 1),
  acoustic_salience REAL NOT NULL CHECK(acoustic_salience >= 0 AND acoustic_salience <= 1),
  transcript_velocity REAL NOT NULL CHECK(transcript_velocity >= 0 AND transcript_velocity <= 1),
  narrative_arc REAL NOT NULL CHECK(narrative_arc >= 0 AND narrative_arc <= 1),
  novelty REAL NOT NULL CHECK(novelty >= 0 AND novelty <= 1),
  word_count INTEGER NOT NULL CHECK(word_count >= 0),
  marker_count INTEGER NOT NULL CHECK(marker_count >= 0),
  rationale TEXT NOT NULL CHECK(length(rationale) <= 500),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(job_id, start_seconds, end_seconds)
);

CREATE INDEX IF NOT EXISTS idx_moment_candidates_owner_job_score
  ON moment_candidates(user_id, job_id, score DESC);
