CREATE TABLE IF NOT EXISTS catalogue_models (
  id TEXT PRIMARY KEY,
  author TEXT NOT NULL,
  name TEXT NOT NULL,
  license TEXT,
  pipeline_tag TEXT,
  parameter_count INTEGER,
  context_window INTEGER,
  downloads INTEGER NOT NULL DEFAULT 0,
  likes INTEGER NOT NULL DEFAULT 0,
  gated TEXT NOT NULL DEFAULT 'none' CHECK (gated IN ('none', 'auto', 'manual')),
  last_modified_at TEXT,
  tags_json TEXT NOT NULL DEFAULT '[]',
  etag TEXT,
  cached_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS catalogue_models_downloads_idx
  ON catalogue_models (downloads DESC);

CREATE INDEX IF NOT EXISTS catalogue_models_updated_idx
  ON catalogue_models (last_modified_at DESC);

CREATE TABLE IF NOT EXISTS model_artifacts (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL REFERENCES catalogue_models (id) ON DELETE CASCADE,
  revision TEXT NOT NULL,
  path TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('safetensors', 'gguf', 'other')),
  quantization TEXT,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT CHECK (sha256 IS NULL OR length(sha256) = 64),
  is_lfs INTEGER NOT NULL DEFAULT 0 CHECK (is_lfs IN (0, 1)),
  runnable INTEGER NOT NULL DEFAULT 1 CHECK (runnable IN (0, 1)),
  UNIQUE (model_id, revision, path)
);

CREATE INDEX IF NOT EXISTS model_artifacts_model_idx
  ON model_artifacts (model_id, revision);
