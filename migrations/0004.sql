CREATE TABLE IF NOT EXISTS delivery_observations (
  outbox_id INTEGER PRIMARY KEY,
  source TEXT NOT NULL,
  queued INTEGER NOT NULL,
  sent INTEGER NOT NULL,
  published INTEGER
);
CREATE INDEX IF NOT EXISTS delivery_observations_sent ON delivery_observations(sent);
CREATE TABLE IF NOT EXISTS scan_usage (
  day TEXT PRIMARY KEY,
  total INTEGER NOT NULL DEFAULT 0,
  background INTEGER NOT NULL DEFAULT 0
);
