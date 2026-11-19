CREATE TABLE IF NOT EXISTS pa_invites (
  id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
  github_id TEXT NOT NULL, login TEXT NOT NULL, created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  revoked_at INTEGER, accepted_at INTEGER, accepted_user_id TEXT, claim_id TEXT
);
CREATE INDEX IF NOT EXISTS pa_invites_created ON pa_invites(created_at);
CREATE TABLE IF NOT EXISTS pa_beta_members (
  user_id TEXT PRIMARY KEY, invite_id TEXT UNIQUE NOT NULL,
  created_at INTEGER NOT NULL, revoked_at INTEGER
);
