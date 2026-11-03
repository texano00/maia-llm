CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS consent_records (
  id TEXT PRIMARY KEY,
  install_id TEXT NOT NULL,
  telemetry_enabled INTEGER NOT NULL DEFAULT 0 CHECK (telemetry_enabled IN (0, 1)),
  policy_version TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  install_token_ref TEXT
);

CREATE TABLE IF NOT EXISTS credential_handles (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('huggingface', 'vastai', 's3')),
  label TEXT NOT NULL,
  vault_handle TEXT NOT NULL,
  last_verified_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('valid', 'invalid', 'unknown'))
);

CREATE TABLE IF NOT EXISTS local_endpoint_runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  address TEXT NOT NULL CHECK (address = '127.0.0.1'),
  port INTEGER NOT NULL CHECK (port BETWEEN 1024 AND 65535),
  model_alias TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'stopped', 'failed')),
  started_at TEXT NOT NULL,
  stopped_at TEXT,
  request_count INTEGER NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  last_activity_at TEXT
);

CREATE TABLE IF NOT EXISTS telemetry_outbox (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('event_batch', 'crash', 'log_bundle', 'environment')),
  payload_json TEXT NOT NULL,
  bytes INTEGER NOT NULL CHECK (bytes BETWEEN 0 AND 262144),
  state TEXT NOT NULL CHECK (state IN ('pending', 'sending', 'sent', 'failed', 'dropped')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS telemetry_outbox_state_idx
  ON telemetry_outbox (state, next_attempt_at);
