import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

const SCHEMA_VERSION = 1;

const CREATE_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  duration_minutes INTEGER,
  due_date TEXT,
  time_effect_type TEXT NOT NULL DEFAULT 'continuous' CHECK(time_effect_type IN ('continuous', 'deadline', 'event_bound')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'completed', 'deferred', 'cancelled')),
  locked INTEGER NOT NULL DEFAULT 0,
  parent_task_id TEXT,
  project TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS task_recurrence_rules (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK(frequency IN ('daily', 'weekly', 'monthly', 'yearly')),
  interval_val INTEGER NOT NULL DEFAULT 1,
  days_of_week TEXT,
  day_of_month INTEGER,
  end_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_relations (
  id TEXT PRIMARY KEY,
  parent_task_id TEXT NOT NULL,
  child_task_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'subtask',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  FOREIGN KEY (child_task_id) REFERENCES tasks(id) ON DELETE CASCADE,
  UNIQUE(parent_task_id, child_task_id)
);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (task_id, tag),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS task_reminders (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  minutes_before INTEGER NOT NULL DEFAULT 15,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  bound_task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (bound_task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS event_recurrence_rules (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK(frequency IN ('daily', 'weekly', 'monthly', 'yearly')),
  interval_val INTEGER NOT NULL DEFAULT 1,
  days_of_week TEXT,
  day_of_month INTEGER,
  end_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS event_reminders (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  minutes_before INTEGER NOT NULL DEFAULT 15,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS schedule_blocks (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  event_id TEXT,
  date TEXT NOT NULL,
  start_time TEXT NOT NULL,
  end_time TEXT NOT NULL,
  locked INTEGER NOT NULL DEFAULT 0,
  manual_signal INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  task_id TEXT,
  event_id TEXT,
  trigger_at TEXT NOT NULL,
  snoozed_until TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'triggered', 'snoozed', 'dismissed', 'completed')),
  message TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE TABLE IF NOT EXISTS action_logs (
  id TEXT PRIMARY KEY,
  capability TEXT NOT NULL,
  actor TEXT NOT NULL,
  origin TEXT NOT NULL,
  idempotency_key TEXT,
  input_snapshot TEXT NOT NULL DEFAULT '{}',
  state_before TEXT,
  state_after TEXT,
  description TEXT,
  undo_group_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS undo_groups (
  id TEXT PRIMARY KEY,
  description TEXT,
  reverted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS preference_signals (
  id TEXT PRIMARY KEY,
  signal_type TEXT NOT NULL,
  signal_data TEXT NOT NULL DEFAULT '{}',
  source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  action_log_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (session_id) REFERENCES ai_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (action_log_id) REFERENCES action_logs(id)
);

CREATE TABLE IF NOT EXISTS daily_summaries (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL UNIQUE,
  completed_items TEXT NOT NULL DEFAULT '[]',
  incomplete_items TEXT NOT NULL DEFAULT '[]',
  deferred_items TEXT NOT NULL DEFAULT '[]',
  next_day_suggestions TEXT NOT NULL DEFAULT '[]',
  raw_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_due_date ON tasks(due_date);
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_time);
CREATE INDEX IF NOT EXISTS idx_schedule_date ON schedule_blocks(date);
CREATE INDEX IF NOT EXISTS idx_reminders_trigger ON reminders(trigger_at);
CREATE INDEX IF NOT EXISTS idx_reminders_status ON reminders(status);
CREATE INDEX IF NOT EXISTS idx_action_logs_capability ON action_logs(capability);
CREATE INDEX IF NOT EXISTS idx_action_logs_actor ON action_logs(actor);
CREATE INDEX IF NOT EXISTS idx_action_logs_idempotency ON action_logs(idempotency_key);
CREATE INDEX IF NOT EXISTS idx_ai_messages_session ON ai_messages(session_id);
CREATE INDEX IF NOT EXISTS idx_daily_summaries_date ON daily_summaries(date);
`;

export class EvolveFlowDatabase {
  private db: Database.Database;

  constructor(dbPath: string) {
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.initialize();
  }

  private initialize(): void {
    const currentVersion = this.getSchemaVersion();
    if (currentVersion === 0) {
      this.db.exec(CREATE_TABLES_SQL);
      this.setSchemaVersion(SCHEMA_VERSION);
      this.setRevision(0);
    }
  }

  private getSchemaVersion(): number {
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key = 'schema_version'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  }

  private setSchemaVersion(version: number): void {
    this.db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schema_version', ?)").run(String(version));
  }

  getRevision(): number {
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key = 'revision'").get() as { value: string } | undefined;
    return row ? parseInt(row.value, 10) : 0;
  }

  setRevision(revision: number): void {
    this.db.prepare("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('revision', ?)").run(String(revision));
  }

  incrementRevision(): number {
    const current = this.getRevision();
    const next = current + 1;
    this.setRevision(next);
    return next;
  }

  getDb(): Database.Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

export function ensureDataDirs(basePath: string): void {
  const dirs = ['', 'memory', 'transcripts', 'exports', 'backups', 'logs'];
  for (const dir of dirs) {
    const fullPath = path.join(basePath, dir);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
    }
  }
}
