CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  model_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('vastai')),
  offer_id INTEGER,
  instance_id INTEGER,
  state TEXT NOT NULL CHECK (
    state IN (
      'estimated',
      'provisioning',
      'ready',
      'active',
      'ending',
      'ended',
      'cancelled',
      'failed'
    )
  ),
  runtime TEXT NOT NULL CHECK (runtime IN ('vllm', 'llamacpp')),
  runtime_version TEXT,
  container_image TEXT NOT NULL,
  gpu_name TEXT,
  gpu_ram_gb INTEGER,
  hourly_rate_microusd INTEGER NOT NULL CHECK (hourly_rate_microusd > 0),
  estimated_total_microusd INTEGER NOT NULL CHECK (estimated_total_microusd > 0),
  label TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ready_at TEXT,
  ended_at TEXT,
  end_reason TEXT CHECK (
    end_reason IS NULL OR end_reason IN ('user', 'idle', 'cap', 'app_exit', 'failure', 'reconciled')
  ),
  failure_code TEXT,
  is_active INTEGER GENERATED ALWAYS AS (
    CASE
      WHEN state IN ('estimated', 'provisioning', 'ready', 'active', 'ending') THEN 1
      ELSE 0
    END
  ) VIRTUAL
);

CREATE UNIQUE INDEX IF NOT EXISTS sessions_single_active_idx
  ON sessions (is_active)
  WHERE is_active = 1;

CREATE INDEX IF NOT EXISTS sessions_started_idx
  ON sessions (started_at DESC);

CREATE TABLE IF NOT EXISTS session_events (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS session_events_session_idx
  ON session_events (session_id, created_at);

CREATE TABLE IF NOT EXISTS cost_records (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  conversation_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('estimate', 'final', 'provider_report')),
  amount_microusd INTEGER NOT NULL CHECK (amount_microusd >= 0),
  duration_ms INTEGER,
  rate_microusd INTEGER,
  currency TEXT NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS cost_records_session_idx
  ON cost_records (session_id, recorded_at);

CREATE TABLE IF NOT EXISTS budgets (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('session', 'month')),
  limit_microusd INTEGER NOT NULL CHECK (limit_microusd > 0),
  warning_pct INTEGER NOT NULL CHECK (warning_pct BETWEEN 1 AND 99),
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
