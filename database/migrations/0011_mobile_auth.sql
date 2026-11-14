CREATE TABLE IF NOT EXISTS mobile_auth_codes (
  code_hash TEXT PRIMARY KEY,
  code_challenge TEXT NOT NULL,
  auth_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  exchange_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_mobile_auth_codes_expiry
  ON mobile_auth_codes(expires_at);

CREATE TABLE IF NOT EXISTS mobile_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_mobile_sessions_user
  ON mobile_sessions(user_id, expires_at);

CREATE TABLE IF NOT EXISTS mobile_media_grants (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  clip_id TEXT NOT NULL REFERENCES clips(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_mobile_media_grants_expiry
  ON mobile_media_grants(expires_at);
