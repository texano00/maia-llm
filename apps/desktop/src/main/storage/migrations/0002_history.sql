CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  model_id TEXT,
  origin TEXT NOT NULL CHECK (origin IN ('app', 'ide')),
  client_label TEXT,
  session_id TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1))
);

CREATE INDEX IF NOT EXISTS conversations_updated_idx
  ON conversations (updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations (id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content TEXT NOT NULL CHECK (
    length(content) > 0 OR (role = 'assistant' AND interrupted = 1)
  ),
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  interrupted INTEGER NOT NULL DEFAULT 0 CHECK (interrupted IN (0, 1)),
  error_code TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (conversation_id, sequence)
);

CREATE INDEX IF NOT EXISTS messages_conversation_idx
  ON messages (conversation_id, sequence);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  conversation_id UNINDEXED,
  content
);

CREATE TRIGGER IF NOT EXISTS messages_ai
AFTER INSERT ON messages
BEGIN
  INSERT INTO messages_fts (rowid, conversation_id, content)
  VALUES (new.rowid, new.conversation_id, new.content);
END;

CREATE TRIGGER IF NOT EXISTS messages_ad
AFTER DELETE ON messages
BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
END;

CREATE TRIGGER IF NOT EXISTS messages_au
AFTER UPDATE ON messages
BEGIN
  DELETE FROM messages_fts WHERE rowid = old.rowid;
  INSERT INTO messages_fts (rowid, conversation_id, content)
  VALUES (new.rowid, new.conversation_id, new.content);
END;
