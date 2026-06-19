import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Reminder, ReminderStatus } from './types.js';

export class ReminderService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(
    taskId: string | null,
    eventId: string | null,
    triggerAt: string,
    message?: string
  ): Reminder {
    const id = uuidv4();
    const now = new Date().toISOString();
    this.db
      .prepare(
        `
      INSERT INTO reminders (id, task_id, event_id, trigger_at, status, message, created_at)
      VALUES (?, ?, ?, ?, 'pending', ?, ?)
    `
      )
      .run(id, taskId, eventId, triggerAt, message ?? null, now);
    return this.getById(id)!;
  }

  getById(id: string): Reminder | null {
    const row = this.db.prepare('SELECT * FROM reminders WHERE id = ?').get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.mapRow(row) : null;
  }

  getDueReminders(): Reminder[] {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare("SELECT * FROM reminders WHERE status = 'pending' AND trigger_at <= ?")
      .all(now) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  snooze(reminderId: string, durationMinutes: number): Reminder {
    if (durationMinutes < 1) {
      throw new Error('durationMinutes must be >= 1');
    }
    const reminder = this.getById(reminderId);
    if (!reminder) {
      throw new Error(`Reminder not found: ${reminderId}`);
    }
    const snoozedUntil = new Date(Date.now() + durationMinutes * 60000).toISOString();
    this.db
      .prepare("UPDATE reminders SET status = 'snoozed', snoozed_until = ? WHERE id = ?")
      .run(snoozedUntil, reminderId);
    return this.getById(reminderId)!;
  }

  markTriggered(reminderId: string): Reminder {
    this.db.prepare("UPDATE reminders SET status = 'triggered' WHERE id = ?").run(reminderId);
    return this.getById(reminderId)!;
  }

  dismiss(reminderId: string): Reminder {
    this.db.prepare("UPDATE reminders SET status = 'dismissed' WHERE id = ?").run(reminderId);
    return this.getById(reminderId)!;
  }

  restoreSnoozed(): Reminder[] {
    const now = new Date().toISOString();
    const rows = this.db
      .prepare("SELECT * FROM reminders WHERE status = 'snoozed' AND snoozed_until <= ?")
      .all(now) as Record<string, unknown>[];
    const ids = rows.map((r) => r.id as string);
    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      this.db
        .prepare(
          `UPDATE reminders SET status = 'pending', snoozed_until = NULL WHERE id IN (${placeholders})`
        )
        .run(...ids);
      const updated = this.db
        .prepare(`SELECT * FROM reminders WHERE id IN (${placeholders})`)
        .all(...ids) as Record<string, unknown>[];
      return updated.map((r) => this.mapRow(r));
    }
    return [];
  }

  private mapRow(row: Record<string, unknown>): Reminder {
    return {
      id: row.id as string,
      task_id: (row.task_id as string) ?? null,
      event_id: (row.event_id as string) ?? null,
      trigger_at: row.trigger_at as string,
      snoozed_until: (row.snoozed_until as string) ?? null,
      status: (row.status as ReminderStatus) ?? 'pending',
      message: (row.message as string) ?? null,
      created_at: row.created_at as string,
    };
  }
}
