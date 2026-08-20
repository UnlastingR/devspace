CREATE TABLE IF NOT EXISTS card_snapshots (
  id TEXT PRIMARY KEY,
  conversation_scope_id TEXT,
  workspace_id TEXT,
  tool TEXT NOT NULL,
  card_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS card_snapshots_conversation_idx
  ON card_snapshots(conversation_scope_id, created_at);

CREATE INDEX IF NOT EXISTS card_snapshots_workspace_idx
  ON card_snapshots(workspace_id, created_at);
