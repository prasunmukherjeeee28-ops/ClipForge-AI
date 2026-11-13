-- Track candidate generation retries and preserve explainable model-free signals.
ALTER TABLE jobs ADD COLUMN candidate_generation_id TEXT;

ALTER TABLE candidates ADD COLUMN generation_id TEXT;
ALTER TABLE candidates ADD COLUMN category TEXT NOT NULL DEFAULT 'unknown'
  CHECK(category IN ('funny','action','fail','glitch','banter','unknown'));
ALTER TABLE candidates ADD COLUMN rationale TEXT;
ALTER TABLE candidates ADD COLUMN signals_json TEXT NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_candidates_generation
  ON candidates(job_id, generation_id, review_status);
