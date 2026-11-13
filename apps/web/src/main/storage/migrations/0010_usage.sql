-- Per-run speed measurements (Models projections + optional usage reporting).
CREATE TABLE IF NOT EXISTS session_metrics (
  session_id TEXT PRIMARY KEY REFERENCES sessions (id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  power_tier TEXT NOT NULL CHECK (power_tier IN ('economy', 'balanced', 'performance')),
  output_tokens INTEGER CHECK (output_tokens IS NULL OR output_tokens >= 0),
  generation_ms INTEGER CHECK (generation_ms IS NULL OR generation_ms >= 0),
  tokens_per_second REAL CHECK (tokens_per_second IS NULL OR tokens_per_second > 0),
  outcome TEXT NOT NULL CHECK (
    outcome IN ('completed', 'failed', 'cancelled', 'capped', 'idle')
  ),
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS session_metrics_model_idx
  ON session_metrics (model_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS session_metrics_recorded_idx
  ON session_metrics (recorded_at);

-- Image attachments live on disk under userData/images; only metadata is stored.
CREATE TABLE IF NOT EXISTS conversation_images (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  message_id TEXT,
  direction TEXT NOT NULL CHECK (direction IN ('input', 'output')),
  mime_type TEXT NOT NULL CHECK (mime_type IN ('image/png', 'image/jpeg', 'image/webp')),
  width INTEGER NOT NULL CHECK (width > 0),
  height INTEGER NOT NULL CHECK (height > 0),
  relative_path TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS conversation_images_conversation_idx
  ON conversation_images (conversation_id);

-- The tier and capability a run was started with travel with the session so the
-- Models view and the cost estimate can never disagree about them.
ALTER TABLE sessions ADD COLUMN power_tier TEXT NOT NULL DEFAULT 'balanced'
  CHECK (power_tier IN ('economy', 'balanced', 'performance'));
ALTER TABLE sessions ADD COLUMN capability TEXT NOT NULL DEFAULT 'text'
  CHECK (capability IN ('text', 'text-to-image', 'image-to-text', 'image-to-image'));
