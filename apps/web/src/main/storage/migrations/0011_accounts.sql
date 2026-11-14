-- Passwordless access (specs/005-web-access).
--
-- The email address is the identity and nothing else: it owns conversations,
-- images, sessions, settings and provider credentials, and deleting the row
-- takes all of them with it.

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE CHECK (length(email) BETWEEN 3 AND 254),
  created_at TEXT NOT NULL,
  last_seen_at TEXT
);

-- One row per issued code. Only a keyed digest of the six digits is stored, so
-- a database read cannot be replayed against the access page.
CREATE TABLE IF NOT EXISTS access_codes (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS access_codes_email_idx
  ON access_codes (email, issued_at DESC);

-- Browser sessions: opaque token in the cookie, digest in the database, so
-- signing out can revoke the row immediately.
CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  user_agent TEXT
);

CREATE INDEX IF NOT EXISTS auth_sessions_account_idx
  ON auth_sessions (account_id, expires_at DESC);

-- Throttle input and audit trail. Only digests: neither the address nor the
-- source address is stored or logged.
CREATE TABLE IF NOT EXISTS auth_events (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (
    kind IN ('code_requested', 'code_failed', 'code_verified', 'signed_out', 'throttled')
  ),
  email_hash TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS auth_events_email_idx
  ON auth_events (email_hash, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_events_ip_idx
  ON auth_events (ip_hash, created_at DESC);
