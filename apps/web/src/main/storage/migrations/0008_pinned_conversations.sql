-- Users can pin their most important conversations to the top of the chat list.
ALTER TABLE conversations ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));

CREATE INDEX IF NOT EXISTS conversations_pinned_idx
  ON conversations (pinned DESC, updated_at DESC);
