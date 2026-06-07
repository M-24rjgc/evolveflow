import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import { TaskService } from './TaskService.js';

export interface DailySummary {
  id: string;
  date: string;
  completed_items: string[];
  incomplete_items: string[];
  deferred_items: string[];
  next_day_suggestions: string[];
  raw_text: string | null;
  created_at: string;
}

export class SummaryService {
  private db: Database.Database;
  private taskService: TaskService;

  constructor(db: Database.Database, taskService: TaskService) {
    this.db = db;
    this.taskService = taskService;
  }

  generateDaily(date: string, forceRefresh: boolean = false): DailySummary {
    if (!forceRefresh) {
      const existing = this.getByDate(date);
      if (existing) {return existing;}
    }

    // Use local date strings instead of Date objects to avoid UTC conversion issues.
    // For example, in UTC+8, midnight local time is 16:00 UTC the previous day.
    // Using local date strings ensures we query the correct local day boundaries.
    const dayStartISO = `${date}T00:00:00`;
    const dayEndISO = `${date}T23:59:59`;
    const todayStr = new Date().toISOString().split('T')[0];

    const completedTasks = (this.db.prepare(
      "SELECT title FROM tasks WHERE status = 'completed' AND updated_at >= ? AND updated_at <= ?"
    ).all(dayStartISO, dayEndISO) as { title: string }[]).map((r) => r.title);

    // Include tasks with due_date matching today AND tasks with no due_date that were created today
    const incompleteTasks = (this.db.prepare(
      "SELECT title FROM tasks WHERE status = 'pending' AND ((due_date IS NOT NULL AND substr(due_date, 1, 10) = ?) OR (due_date IS NULL AND substr(created_at, 1, 10) = ?))"
    ).all(date, date) as { title: string }[]).map((r) => r.title);

    // Use local date strings for deferred tasks as well
    const deferredTasks = (this.db.prepare(
      "SELECT title FROM tasks WHERE status = 'deferred' AND updated_at >= ? AND updated_at <= ?"
    ).all(dayStartISO, dayEndISO) as { title: string }[]).map((r) => r.title);

    const id = uuidv4();
    const now = new Date().toISOString();

    const summary: DailySummary = {
      id,
      date,
      completed_items: completedTasks,
      incomplete_items: incompleteTasks,
      deferred_items: deferredTasks,
      next_day_suggestions: [],
      raw_text: null,
      created_at: now,
    };

    this.db.prepare(`
      INSERT INTO daily_summaries (id, date, completed_items, incomplete_items, deferred_items, next_day_suggestions, raw_text, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, date,
      JSON.stringify(summary.completed_items),
      JSON.stringify(summary.incomplete_items),
      JSON.stringify(summary.deferred_items),
      JSON.stringify(summary.next_day_suggestions),
      summary.raw_text,
      now,
    );

    return summary;
  }

  getByDate(date: string): DailySummary | null {
    const row = this.db.prepare('SELECT * FROM daily_summaries WHERE date = ?').get(date) as Record<string, unknown> | undefined;
    if (!row) {return null;}
    return {
      id: row.id as string,
      date: row.date as string,
      completed_items: JSON.parse(row.completed_items as string),
      incomplete_items: JSON.parse(row.incomplete_items as string),
      deferred_items: JSON.parse(row.deferred_items as string),
      next_day_suggestions: JSON.parse(row.next_day_suggestions as string),
      raw_text: (row.raw_text as string) ?? null,
      created_at: row.created_at as string,
    };
  }
}
