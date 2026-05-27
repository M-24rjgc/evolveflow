import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Task, CreateTaskInput, UpdateTaskInput, TimeEffectType, TaskStatus } from './types.js';

export class TaskService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(input: CreateTaskInput): Task {
    const id = uuidv4();
    const now = new Date().toISOString();

    const createTaskTransaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO tasks (id, title, description, duration_minutes, due_date, time_effect_type, status, locked, parent_task_id, project, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, 0, ?, ?)
      `).run(
        id,
        input.title,
        input.description ?? '',
        input.duration_minutes ?? null,
        input.due_date ?? null,
        input.time_effect_type ?? 'continuous',
        input.parent_task_id ?? null,
        input.project ?? null,
        now,
        now,
      );

      if (input.tags && input.tags.length > 0) {
        const tagStmt = this.db.prepare('INSERT INTO task_tags (task_id, tag) VALUES (?, ?)');
        for (const tag of input.tags) {
          tagStmt.run(id, tag);
        }
      }
    });
    createTaskTransaction();
    return this.getById(id)!;
  }

  getById(id: string): Task | null {
    const row = this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.mapRowToTask(row);
  }

  list(filters?: { status?: TaskStatus; project?: string }): Task[] {
    let sql = 'SELECT * FROM tasks WHERE 1=1';
    const params: unknown[] = [];
    if (filters?.status) {
      sql += ' AND status = ?';
      params.push(filters.status);
    }
    if (filters?.project) {
      sql += ' AND project = ?';
      params.push(filters.project);
    }
    sql += ' ORDER BY sort_order, created_at';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapRowToTask(r));
  }

  update(input: UpdateTaskInput): Task {
    const existing = this.getById(input.task_id);
    if (!existing) throw new Error(`Task not found: ${input.task_id}`);
    if (existing.locked) throw new Error(`Task is locked: ${input.task_id}`);

    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title); }
    if (input.description !== undefined) { sets.push('description = ?'); params.push(input.description); }
    if (input.duration_minutes !== undefined) { sets.push('duration_minutes = ?'); params.push(input.duration_minutes); }
    if (input.due_date !== undefined) { sets.push('due_date = ?'); params.push(input.due_date); }
    if (input.time_effect_type !== undefined) { sets.push('time_effect_type = ?'); params.push(input.time_effect_type); }
    if (input.project !== undefined) { sets.push('project = ?'); params.push(input.project); }

    params.push(input.task_id);

    const updateTaskTransaction = this.db.transaction(() => {
      this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);

      if (input.tags !== undefined) {
        this.db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(input.task_id);
        const tagStmt = this.db.prepare('INSERT INTO task_tags (task_id, tag) VALUES (?, ?)');
        for (const tag of input.tags) {
          tagStmt.run(input.task_id, tag);
        }
      }
    });
    updateTaskTransaction();

    return this.getById(input.task_id)!;
  }

  complete(taskId: string): Task {
    const existing = this.getById(taskId);
    if (!existing) throw new Error(`Task not found: ${taskId}`);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = ?").run(now, taskId);
    return this.getById(taskId)!;
  }

  defer(taskId: string, newDueDate?: string): Task {
    const existing = this.getById(taskId);
    if (!existing) throw new Error(`Task not found: ${taskId}`);
    const now = new Date().toISOString();
    this.db.prepare("UPDATE tasks SET status = 'deferred', due_date = ?, updated_at = ? WHERE id = ?").run(newDueDate ?? existing.due_date, now, taskId);
    return this.getById(taskId)!;
  }

  lock(taskId: string, locked: boolean): Task {
    const existing = this.getById(taskId);
    if (!existing) throw new Error(`Task not found: ${taskId}`);
    const now = new Date().toISOString();
    this.db.prepare('UPDATE tasks SET locked = ?, updated_at = ? WHERE id = ?').run(locked ? 1 : 0, now, taskId);
    return this.getById(taskId)!;
  }

  getSubTasks(parentTaskId: string): Task[] {
    const rows = this.db.prepare('SELECT * FROM tasks WHERE parent_task_id = ? ORDER BY sort_order').all(parentTaskId) as Record<string, unknown>[];
    return rows.map((r) => this.mapRowToTask(r));
  }

  expandRecurring(fromDate: string, toDate: string): Task[] {
    const rules = this.db.prepare('SELECT * FROM task_recurrence_rules').all() as Record<string, unknown>[];
    const expanded: Task[] = [];
    const from = new Date(fromDate);
    const to = new Date(toDate);

    for (const rule of rules) {
      const task = this.getById(rule.task_id as string);
      if (!task) continue;

      const interval = (rule.interval_val as number) || 1;
      const frequency = rule.frequency as string;
      const endDate = rule.end_date ? new Date(rule.end_date as string) : null;
      const daysOfWeek = (rule.days_of_week as string)?.split(',').map((d) => parseInt(d.trim(), 10)) || [];

      let currentDate = new Date(from);

      while (currentDate <= to) {
        if (endDate && currentDate > endDate) break;

        let shouldExpand = false;
        if (frequency === 'daily') {
          const dayDiff = Math.floor((currentDate.getTime() - new Date(task.created_at).getTime()) / (86400000));
          shouldExpand = dayDiff >= 0 && dayDiff % interval === 0;
        } else if (frequency === 'weekly') {
          const weekDiff = Math.floor((currentDate.getTime() - new Date(task.created_at).getTime()) / (7 * 86400000));
          shouldExpand = weekDiff >= 0 && weekDiff % interval === 0;
          if (shouldExpand && daysOfWeek.length > 0) {
            shouldExpand = daysOfWeek.includes(currentDate.getDay());
          }
        } else if (frequency === 'monthly') {
          const monthDiff = (currentDate.getFullYear() - new Date(task.created_at).getFullYear()) * 12
            + (currentDate.getMonth() - new Date(task.created_at).getMonth());
          shouldExpand = monthDiff >= 0 && monthDiff % interval === 0;
          if (shouldExpand && rule.day_of_month) {
            shouldExpand = currentDate.getDate() === (rule.day_of_month as number);
          }
        } else if (frequency === 'yearly') {
          const yearDiff = currentDate.getFullYear() - new Date(task.created_at).getFullYear();
          shouldExpand = yearDiff > 0
            && yearDiff % interval === 0
            && currentDate.getMonth() === new Date(task.created_at).getMonth()
            && currentDate.getDate() === new Date(task.created_at).getDate();
        }

        if (shouldExpand) {
          expanded.push({
            ...task,
            id: `${task.id}_${currentDate.toISOString().split('T')[0]}`,
            due_date: currentDate.toISOString().split('T')[0],
            created_at: currentDate.toISOString(),
          });
        }

        if (frequency === 'daily') {
          currentDate.setDate(currentDate.getDate() + interval);
        } else if (frequency === 'weekly') {
          currentDate.setDate(currentDate.getDate() + 7 * interval);
        } else if (frequency === 'monthly') {
          currentDate.setMonth(currentDate.getMonth() + interval);
        } else {
          currentDate.setDate(currentDate.getDate() + 1);
        }
      }
    }

    return expanded;
  }

  private mapRowToTask(row: Record<string, unknown>): Task {
    const tags = this.db.prepare('SELECT tag FROM task_tags WHERE task_id = ?').all(row.id as string) as { tag: string }[];
    return {
      id: row.id as string,
      title: row.title as string,
      description: (row.description as string) ?? '',
      duration_minutes: (row.duration_minutes as number) ?? null,
      due_date: (row.due_date as string) ?? null,
      time_effect_type: (row.time_effect_type as TimeEffectType) ?? 'continuous',
      status: (row.status as TaskStatus) ?? 'pending',
      locked: Boolean(row.locked),
      parent_task_id: (row.parent_task_id as string) ?? null,
      project: (row.project as string) ?? null,
      tags: tags.map((t) => t.tag),
      sort_order: (row.sort_order as number) ?? 0,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
