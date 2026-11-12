CREATE TABLE IF NOT EXISTS processor_request_nonces (
  nonce_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_processor_nonces_created
  ON processor_request_nonces(created_at);
