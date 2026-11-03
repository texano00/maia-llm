-- Parallel sessions are allowed from 0.3.0: one session per model conversation
-- instead of a single installation-wide session.
DROP INDEX IF EXISTS sessions_single_active_idx;

CREATE INDEX IF NOT EXISTS sessions_model_idx
  ON sessions (model_id, started_at DESC);
