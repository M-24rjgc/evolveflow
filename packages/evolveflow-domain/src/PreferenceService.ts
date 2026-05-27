import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';

export interface Preference {
  key: string;
  value: string;
  updated_at: string;
}

export class PreferenceService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  get(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM preferences WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  set(key: string, value: string): void {
    const now = new Date().toISOString();
    this.db.prepare('INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now);
  }

  getAll(): Preference[] {
    const rows = this.db.prepare('SELECT * FROM preferences ORDER BY key').all() as Record<string, unknown>[];
    return rows.map((r) => ({
      key: r.key as string,
      value: r.value as string,
      updated_at: r.updated_at as string,
    }));
  }

  getWorkHours(): { start: string; end: string } {
    return {
      start: this.get('work_hours_start') ?? '09:00',
      end: this.get('work_hours_end') ?? '18:00',
    };
  }

  setWorkHours(start: string, end: string): void {
    this.set('work_hours_start', start);
    this.set('work_hours_end', end);
  }

  recordSignal(signalType: string, signalData: Record<string, unknown>, source: string): void {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO preference_signals (id, signal_type, signal_data, source, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, signalType, JSON.stringify(signalData), source, now);
  }
}
