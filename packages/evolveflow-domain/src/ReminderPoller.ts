import type Database from 'better-sqlite3';

export interface PolledReminder {
  id: string;
  task_id: string | null;
  event_id: string | null;
  trigger_at: string;
  message: string | null;
}

export interface FollowUpResult {
  reminderId: string;
  message: string;
  suggestion: string;
}

export class ReminderPoller {
  private db: Database.Database;
  private lastPollTime: Date = new Date();
  private checkIntervalMs: number;

  constructor(db: Database.Database, checkIntervalMs: number = 10000) {
    this.db = db;
    this.checkIntervalMs = checkIntervalMs;
  }

  pollDueReminders(): PolledReminder[] {
    const now = new Date().toISOString();
    const rows = this.db.prepare(
      "SELECT * FROM reminders WHERE status = 'pending' AND trigger_at <= ? AND trigger_at > ?"
    ).all(now, this.lastPollTime.toISOString()) as Record<string, unknown>[];

    this.lastPollTime = new Date();

    if (rows.length > 0) {
      const ids = rows.map((r) => r.id as string);
      const placeholders = ids.map(() => '?').join(',');
      this.db.prepare(`UPDATE reminders SET status = 'triggered' WHERE id IN (${placeholders})`).run(...ids);
    }

    return rows.map((r) => ({
      id: r.id as string,
      task_id: (r.task_id as string) ?? null,
      event_id: (r.event_id as string) ?? null,
      trigger_at: r.trigger_at as string,
      message: (r.message as string) ?? null,
    }));
  }

  pollFollowUps(): FollowUpResult[] {
    const now = new Date().toISOString();
    const results: FollowUpResult[] = [];

    const overdueTasks = this.db.prepare(
      "SELECT id, title, due_date FROM tasks WHERE status = 'pending' AND due_date IS NOT NULL AND due_date <= ?"
    ).all(now) as Record<string, unknown>[];

    for (const task of overdueTasks) {
      const existing = this.db.prepare(
        "SELECT 1 FROM reminders WHERE task_id = ? AND message LIKE '催办%' AND status = 'pending'"
      ).get(task.id as string);
      if (existing) continue;

      const dueDate = new Date(task.due_date as string);
      const overdueMinutes = Math.floor((Date.now() - dueDate.getTime()) / 60000);

      let suggestion = '';
      if (overdueMinutes <= 60) {
        suggestion = `建议尽快开始，或延期到稍后时间`;
      } else if (overdueMinutes <= 1440) {
        suggestion = `已超时 ${Math.floor(overdueMinutes / 60)} 小时，建议延期或取消`;
      } else {
        suggestion = `已超时 ${Math.floor(overdueMinutes / 1440)} 天，建议重新评估优先级或取消`;
      }

      const reminderId = `followup-${task.id}-${Date.now()}`;
      this.db.prepare(`
        INSERT INTO reminders (id, task_id, trigger_at, status, message, created_at)
        VALUES (?, ?, ?, 'pending', ?, ?)
      `).run(reminderId, task.id as string, now, `催办：任务"${task.title}"已超时`, now);

      results.push({
        reminderId,
        message: `任务"${task.title}"已超时`,
        suggestion,
      });
    }

    return results;
  }

  shouldTriggerDailySummary(): boolean {
    const now = new Date();
    return now.getHours() === 23 && now.getMinutes() === 0;
  }
}