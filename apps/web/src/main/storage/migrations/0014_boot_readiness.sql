-- Feature 011: a boot is judged by evidence, not by a clock.
--
-- The facts the product shows while a run starts, the address it serves on, and
-- the reason it was released. Nothing here is a secret and nothing here is
-- conversation content: the per-run API key stays in memory.

ALTER TABLE sessions ADD COLUMN boot_phase TEXT;
ALTER TABLE sessions ADD COLUMN boot_percent INTEGER
  CHECK (boot_percent IS NULL OR boot_percent BETWEEN 0 AND 100);
ALTER TABLE sessions ADD COLUMN boot_progress_at TEXT;
ALTER TABLE sessions ADD COLUMN boot_ceiling_at TEXT;
ALTER TABLE sessions ADD COLUMN endpoint_host TEXT;
ALTER TABLE sessions ADD COLUMN endpoint_port INTEGER;
ALTER TABLE sessions ADD COLUMN release_reason TEXT;
ALTER TABLE sessions ADD COLUMN release_phase TEXT;
ALTER TABLE sessions ADD COLUMN release_elapsed_ms INTEGER;

-- The operator tally groups by day and reason, so both columns are read together.
CREATE INDEX IF NOT EXISTS sessions_release_idx
  ON sessions (release_reason, ended_at)
  WHERE release_reason IS NOT NULL;
