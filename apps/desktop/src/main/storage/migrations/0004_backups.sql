CREATE TABLE IF NOT EXISTS backup_records (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  storage_alias TEXT,
  bucket TEXT NOT NULL CHECK (
    length(bucket) BETWEEN 3 AND 63 AND bucket NOT GLOB '*[[:space:]]*'
  ),
  prefix TEXT NOT NULL CHECK (
    length(prefix) <= 1024 AND prefix NOT LIKE '/%' AND prefix NOT LIKE '%..%'
  ),
  manifest_key TEXT,
  status TEXT NOT NULL CHECK (
    status IN (
      'queued',
      'validating',
      'uploading',
      'paused',
      'verifying',
      'completed',
      'failed',
      'broken'
    )
  ),
  total_bytes INTEGER NOT NULL DEFAULT 0 CHECK (total_bytes >= 0),
  verified_at TEXT,
  last_error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS backup_records_status_idx
  ON backup_records (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS backup_artifacts (
  backup_id TEXT NOT NULL REFERENCES backup_records (id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  upload_status TEXT NOT NULL CHECK (
    upload_status IN ('pending', 'uploading', 'stored', 'failed')
  ),
  stored_checksum TEXT,
  part_count INTEGER,
  PRIMARY KEY (backup_id, path)
);
