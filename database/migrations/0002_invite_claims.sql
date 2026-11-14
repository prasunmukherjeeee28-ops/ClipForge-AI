CREATE TABLE IF NOT EXISTS invite_claims (
  invite_hash TEXT PRIMARY KEY,
  auth_subject TEXT NOT NULL UNIQUE,
  claimed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TRIGGER IF NOT EXISTS enforce_two_clipforge_users
BEFORE INSERT ON users
WHEN (SELECT COUNT(*) FROM users) >= 2
BEGIN
  SELECT RAISE(ABORT, 'ClipForge supports exactly two accounts');
END;
