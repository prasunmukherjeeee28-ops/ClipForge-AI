ALTER TABLE candidates ADD COLUMN acoustic_salience REAL NOT NULL DEFAULT 0
  CHECK(acoustic_salience BETWEEN 0 AND 1);
ALTER TABLE candidates ADD COLUMN transcript_velocity REAL NOT NULL DEFAULT 0
  CHECK(transcript_velocity BETWEEN 0 AND 1);
ALTER TABLE candidates ADD COLUMN narrative_arc REAL NOT NULL DEFAULT 0
  CHECK(narrative_arc BETWEEN 0 AND 1);
ALTER TABLE candidates ADD COLUMN novelty REAL NOT NULL DEFAULT 0
  CHECK(novelty BETWEEN 0 AND 1);
ALTER TABLE candidates ADD COLUMN word_count INTEGER NOT NULL DEFAULT 0 CHECK(word_count >= 0);
ALTER TABLE candidates ADD COLUMN marker_count INTEGER NOT NULL DEFAULT 0 CHECK(marker_count >= 0);
ALTER TABLE candidates ADD COLUMN rationale TEXT NOT NULL DEFAULT '' CHECK(length(rationale) <= 500);

CREATE INDEX IF NOT EXISTS idx_candidates_job_score
  ON candidates(job_id, score DESC, start_seconds ASC);
