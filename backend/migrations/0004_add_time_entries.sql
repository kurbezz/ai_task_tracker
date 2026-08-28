CREATE TABLE time_entries (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  entry_date TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE daily_time_syncs (
  entry_date TEXT PRIMARY KEY NOT NULL,
  clockify_entry_id TEXT,
  synced_at TEXT
);
