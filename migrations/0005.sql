CREATE TABLE IF NOT EXISTS pending_cards (
  url TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  request_id INTEGER NOT NULL,
  lease TEXT,
  available INTEGER NOT NULL DEFAULT 0
);
