-- Reasoning ("thinking") tokens that reasoning models stream before the answer.
-- Stored per assistant message so the transcript can show or hide them later
-- instead of discarding them when the stream ends.
ALTER TABLE messages ADD COLUMN reasoning TEXT;
