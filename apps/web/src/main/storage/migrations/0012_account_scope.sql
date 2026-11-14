-- Account scoping (specs/005-web-access).
--
-- Every row that belongs to a person gains `account_id`. Rows written before
-- this feature keep NULL and are invisible to every scoped query: there is no
-- adoption path, because guessing an owner would hand data to whoever signs up
-- first.
--
-- The foreign keys cascade, so deleting an account removes its conversations,
-- messages (through the conversation), images metadata, sessions, metrics,
-- settings and credentials in one statement. Image files are removed by the
-- service before the row goes away.

ALTER TABLE conversations
  ADD COLUMN account_id TEXT REFERENCES accounts (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS conversations_account_idx
  ON conversations (account_id, updated_at DESC);

ALTER TABLE sessions
  ADD COLUMN account_id TEXT REFERENCES accounts (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS sessions_account_idx
  ON sessions (account_id, started_at DESC);

ALTER TABLE conversation_images
  ADD COLUMN account_id TEXT REFERENCES accounts (id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS conversation_images_account_idx
  ON conversation_images (account_id, conversation_id);

-- Provider credentials are per account now: two people may each store their own
-- Hugging Face token, so the primary key is (account_id, id) where `id` is the
-- provider name.
CREATE TABLE credential_handles_scoped (
  account_id TEXT NOT NULL,
  id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('huggingface', 'vastai', 's3')),
  label TEXT NOT NULL,
  vault_handle TEXT NOT NULL,
  last_verified_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('valid', 'invalid', 'unknown')),
  PRIMARY KEY (account_id, id),
  FOREIGN KEY (account_id) REFERENCES accounts (id) ON DELETE CASCADE
);

-- Legacy rows have no owner; '' is never a real account id, so they stay
-- unreachable instead of being silently assigned to the first account.
INSERT INTO credential_handles_scoped
  (account_id, id, provider, label, vault_handle, last_verified_at, status)
SELECT '', id, provider, label, vault_handle, last_verified_at, status
FROM credential_handles;

DROP TABLE credential_handles;

ALTER TABLE credential_handles_scoped RENAME TO credential_handles;

-- Ciphertext for provider secrets. The AES-256-GCM additional data is the
-- account id, so a ciphertext moved to another account does not decrypt.
CREATE TABLE IF NOT EXISTS credential_secrets (
  account_id TEXT NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('huggingface', 'vastai', 's3')),
  ciphertext BLOB NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, provider)
);

-- Settings are per account; `preferences` stays for deployment-wide state and
-- legacy rows.
CREATE TABLE IF NOT EXISTS account_settings (
  account_id TEXT PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
