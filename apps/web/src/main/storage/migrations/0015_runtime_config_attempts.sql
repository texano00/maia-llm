-- Feature 012: runtime values a person can change, and attempts that stay.
--
-- Two additive changes:
--
-- 1. A run may show and change the values its model server starts with. The
--    values and the ceilings they were checked against are stored as JSON; the
--    advisory memory estimate is derived on read, not stored.
-- 2. Regenerating or editing a turn supersedes rows instead of deleting them.
--    Visible queries filter them out; a full transcript still returns them, so
--    nothing the person already saw is destroyed.
--
-- Nothing here is a secret and nothing here is conversation content beyond what
-- the conversation already stores. The per-run key stays in memory.

ALTER TABLE sessions ADD COLUMN runtime_config_json TEXT;
ALTER TABLE sessions ADD COLUMN restart_json TEXT;

CREATE TABLE IF NOT EXISTS session_restarts (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  account_id TEXT,
  requested_at TEXT NOT NULL,
  previous_json TEXT NOT NULL,
  target_json TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('started', 'succeeded', 'failed', 'refused')),
  reason TEXT,
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS session_restarts_session_idx
  ON session_restarts (session_id, requested_at);

ALTER TABLE messages ADD COLUMN superseded_at TEXT;
ALTER TABLE messages ADD COLUMN superseded_by TEXT;

CREATE INDEX IF NOT EXISTS messages_visible_idx
  ON messages (conversation_id, sequence)
  WHERE superseded_at IS NULL;
