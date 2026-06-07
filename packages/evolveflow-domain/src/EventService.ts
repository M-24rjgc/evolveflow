import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Event, CreateEventInput, UpdateEventInput } from './types.js';

export class EventService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(input: CreateEventInput): Event {
    if (new Date(input.start_time) >= new Date(input.end_time)) {
      throw new Error(`Event start_time (${input.start_time}) must be before end_time (${input.end_time})`);
    }

    const id = uuidv4();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO events (id, title, description, start_time, end_time, locked, bound_task_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
    `).run(
      id,
      input.title,
      input.description ?? '',
      input.start_time,
      input.end_time,
      input.bound_task_id ?? null,
      now,
      now,
    );

    return this.getById(id)!;
  }

  getById(id: string): Event | null {
    const row = this.db.prepare('SELECT * FROM events WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) {return null;}
    return this.mapRowToEvent(row);
  }

  list(dateRange?: { start: string; end: string }): Event[] {
    let sql = 'SELECT * FROM events WHERE 1=1';
    const params: unknown[] = [];
    if (dateRange) {
      sql += ' AND start_time < ? AND end_time > ?';
      params.push(dateRange.end, dateRange.start);
    }
    sql += ' ORDER BY start_time';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapRowToEvent(r));
  }

  update(input: UpdateEventInput): Event {
    const existing = this.getById(input.event_id);
    if (!existing) {throw new Error(`Event not found: ${input.event_id}`);}
    if (existing.locked) {throw new Error(`Event is locked: ${input.event_id}`);}

    // Determine effective start_time and end_time for validation
    const effectiveStart = input.start_time ?? existing.start_time;
    const effectiveEnd = input.end_time ?? existing.end_time;
    if (new Date(effectiveStart) >= new Date(effectiveEnd)) {
      throw new Error(`Event start_time (${effectiveStart}) must be before end_time (${effectiveEnd})`);
    }

    const now = new Date().toISOString();
    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [now];

    if (input.title !== undefined) { sets.push('title = ?'); params.push(input.title); }
    if (input.description !== undefined) { sets.push('description = ?'); params.push(input.description); }
    if (input.start_time !== undefined) { sets.push('start_time = ?'); params.push(input.start_time); }
    if (input.end_time !== undefined) { sets.push('end_time = ?'); params.push(input.end_time); }

    params.push(input.event_id);
    this.db.prepare(`UPDATE events SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    return this.getById(input.event_id)!;
  }

  delete(id: string): void {
    const existing = this.getById(id);
    if (!existing) {throw new Error(`Event not found: ${id}`);}
    if (existing.locked) {throw new Error('Cannot delete locked event');}

    const deleteTransaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM event_recurrence_rules WHERE event_id = ?').run(id);
      this.db.prepare('DELETE FROM reminders WHERE event_id = ?').run(id);
      this.db.prepare('DELETE FROM schedule_blocks WHERE event_id = ?').run(id);
      this.db.prepare('DELETE FROM events WHERE id = ?').run(id);
    });
    deleteTransaction();
  }

  lock(eventId: string, locked: boolean): Event {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE events SET locked = ?, updated_at = ? WHERE id = ?').run(locked ? 1 : 0, now, eventId);
    return this.getById(eventId)!;
  }

  findConflicts(startTime: string, endTime: string, excludeEventId?: string): Event[] {
    let sql = 'SELECT * FROM events WHERE start_time < ? AND end_time > ?';
    const params: unknown[] = [endTime, startTime];
    if (excludeEventId) {
      sql += ' AND id != ?';
      params.push(excludeEventId);
    }
    sql += ' ORDER BY start_time';
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapRowToEvent(r));
  }

  expandRecurring(fromDate: string, toDate: string): Event[] {
    const rules = this.db.prepare('SELECT * FROM event_recurrence_rules').all() as Record<string, unknown>[];
    const expanded: Event[] = [];
    const from = new Date(fromDate);
    const to = new Date(toDate);

    for (const rule of rules) {
      const event = this.getById(rule.event_id as string);
      if (!event) {continue;}

      let interval = (rule.interval_val as number) || 1;
      // Validate interval: negative values cause an infinite loop since currentDate moves backwards
      if (interval <= 0) {interval = 1;}
      const frequency = rule.frequency as string;
      const endDate = rule.end_date ? new Date(rule.end_date as string) : null;
      const daysOfWeek = (rule.days_of_week as string)?.split(',').map((d) => parseInt(d.trim(), 10)) || [];
      const eventStart = new Date(event.start_time);
      const durationMs = new Date(event.end_time).getTime() - eventStart.getTime();

      const currentDate = new Date(from);

      while (currentDate <= to) {
        if (endDate && currentDate > endDate) {break;}

        let shouldExpand = false;
        if (frequency === 'daily') {
          const dayDiff = Math.floor((currentDate.getTime() - new Date(event.created_at).getTime()) / (86400000));
          shouldExpand = dayDiff >= 0 && dayDiff % interval === 0;
        } else if (frequency === 'weekly') {
          const weekDiff = Math.floor((currentDate.getTime() - new Date(event.created_at).getTime()) / (7 * 86400000));
          shouldExpand = weekDiff >= 0 && weekDiff % interval === 0;
          if (shouldExpand && daysOfWeek.length > 0) {
            shouldExpand = daysOfWeek.includes(currentDate.getDay());
          }
        } else if (frequency === 'monthly') {
          const monthDiff = (currentDate.getFullYear() - eventStart.getFullYear()) * 12
            + (currentDate.getMonth() - eventStart.getMonth());
          shouldExpand = monthDiff >= 0 && monthDiff % interval === 0;
          if (shouldExpand && rule.day_of_month) {
            shouldExpand = currentDate.getDate() === (rule.day_of_month as number);
          }
        } else if (frequency === 'yearly') {
          const yearDiff = currentDate.getFullYear() - eventStart.getFullYear();
          shouldExpand = yearDiff > 0
            && yearDiff % interval === 0
            && currentDate.getMonth() === eventStart.getMonth()
            && currentDate.getDate() === eventStart.getDate();
        }

        if (shouldExpand) {
          const expandedStart = new Date(currentDate);
          expandedStart.setHours(eventStart.getHours(), eventStart.getMinutes(), eventStart.getSeconds());
          const expandedEnd = new Date(expandedStart.getTime() + durationMs);

          expanded.push({
            ...event,
            id: `${event.id}_${currentDate.toISOString().split('T')[0]}`,
            start_time: expandedStart.toISOString(),
            end_time: expandedEnd.toISOString(),
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

  private mapRowToEvent(row: Record<string, unknown>): Event {
    return {
      id: row.id as string,
      title: row.title as string,
      description: (row.description as string) ?? '',
      start_time: row.start_time as string,
      end_time: row.end_time as string,
      locked: Boolean(row.locked),
      bound_task_id: (row.bound_task_id as string) ?? null,
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
