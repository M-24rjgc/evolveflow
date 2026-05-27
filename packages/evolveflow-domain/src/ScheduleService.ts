import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Task, Event, ScheduleBlock } from './types.js';
import { TaskService } from './TaskService.js';
import { EventService } from './EventService.js';
import { PreferenceService } from './PreferenceService.js';

export interface ScheduleExplanation {
  block_id: string;
  reasons: string[];
  key_factors: string[];
}

export class ScheduleService {
  private db: Database.Database;
  private taskService: TaskService;
  private eventService: EventService;
  private preferenceService: PreferenceService;

  constructor(db: Database.Database, taskService: TaskService, eventService: EventService, preferenceService: PreferenceService) {
    this.db = db;
    this.taskService = taskService;
    this.eventService = eventService;
    this.preferenceService = preferenceService;
  }

  planDay(date: string): ScheduleBlock[] {
    this.clearDaySchedule(date);

    const lockedRows = this.db.prepare(
      'SELECT * FROM schedule_blocks WHERE date = ? AND locked = 1'
    ).all(date) as Record<string, unknown>[];
    const lockedBlocks = lockedRows.map((r) => this.mapRowToBlock(r));

    const events = this.eventService.list({
      start: `${date}T00:00:00`,
      end: `${date}T23:59:59`,
    });

    const tasks = this.taskService.list({ status: 'pending' });
    const schedulableTasks = tasks.filter((t) => {
      if (t.locked) return false;
      if (t.parent_task_id) {
        const subTasks = this.taskService.getSubTasks(t.parent_task_id);
        if (subTasks.length > 0) return false;
      }
      return t.duration_minutes && t.duration_minutes > 0;
    });

    const now = new Date().toISOString();
    const blocks: ScheduleBlock[] = [...lockedBlocks];

    for (const event of events) {
      const block: ScheduleBlock = {
        id: uuidv4(),
        event_id: event.id,
        task_id: null,
        date,
        start_time: event.start_time,
        end_time: event.end_time,
        locked: event.locked,
        manual_signal: false,
        created_at: now,
        updated_at: now,
      };
      this.persistBlock(block);
      blocks.push(block);
    }

    const occupiedSlots = this.getOccupiedSlots(date, blocks);
    const availableSlots = this.getAvailableSlots(date, occupiedSlots);

    const sortedTasks = [...schedulableTasks].sort((a, b) => {
      if (a.due_date && b.due_date) return a.due_date.localeCompare(b.due_date);
      if (a.due_date) return -1;
      if (b.due_date) return 1;
      return 0;
    });

    for (const task of sortedTasks) {
      const slot = this.findSlotForTask(task, availableSlots, date);
      if (slot) {
        const block: ScheduleBlock = {
          id: uuidv4(),
          task_id: task.id,
          event_id: null,
          date,
          start_time: slot.start,
          end_time: slot.end,
          locked: false,
          manual_signal: false,
          created_at: now,
          updated_at: now,
        };
        this.persistBlock(block);
        blocks.push(block);
        this.updateAvailableSlots(availableSlots, slot);
      } else {
        // Task doesn't fit - auto-defer to next day
        const nextDay = new Date(date);
        nextDay.setDate(nextDay.getDate() + 1);
        const newDueDate = nextDay.toISOString().split('T')[0];
        try {
          this.taskService.defer(task.id, newDueDate);
          blocks.push({
            id: uuidv4(),
            task_id: task.id,
            event_id: null,
            date,
            start_time: '',
            end_time: '',
            locked: false,
            manual_signal: false,
            created_at: now,
            updated_at: now,
          });
        } catch {
          // Task is locked, skip silently
        }
      }
    }

    return blocks;
  }

  planRange(startDate: string, endDate: string): ScheduleBlock[] {
    const blocks: ScheduleBlock[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      blocks.push(...this.planDay(dateStr));
    }
    return blocks;
  }

  rebalance(date: string): ScheduleBlock[] {
    const existingBlocks = this.getDaySchedule(date);
    const lockedBlocks = existingBlocks.filter((b) => b.locked);
    const unlockedBlocks = existingBlocks.filter((b) => !b.locked);

    for (const block of unlockedBlocks) {
      this.db.prepare('DELETE FROM schedule_blocks WHERE id = ?').run(block.id);
    }

    const occupiedSlots = lockedBlocks.map((b) => ({ start: b.start_time, end: b.end_time }));
    const availableSlots = this.getAvailableSlots(date, occupiedSlots);

    const tasks = this.taskService.list({ status: 'pending' });
    const schedulableTasks = tasks.filter((t) => !t.locked && !t.parent_task_id && t.duration_minutes);

    const newBlocks: ScheduleBlock[] = [];
    for (const task of schedulableTasks) {
      const slot = this.findSlotForTask(task, availableSlots, date);
      if (slot) {
        const block: ScheduleBlock = { id: uuidv4(), task_id: task.id, event_id: null, date, start_time: slot.start, end_time: slot.end, locked: false, manual_signal: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
        this.persistBlock(block);
        newBlocks.push(block);
        this.updateAvailableSlots(availableSlots, slot);
      }
    }

    return [...lockedBlocks, ...newBlocks];
  }

  explain(blockId: string): ScheduleExplanation | null {
    const block = this.db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get(blockId) as Record<string, unknown> | undefined;
    if (!block) return null;

    const reasons: string[] = [];
    const keyFactors: string[] = [];

    if (block.event_id) {
      reasons.push('固定事件占位');
      keyFactors.push('event');
    }

    if (block.task_id) {
      const task = this.taskService.getById(block.task_id as string);
      if (task) {
        if (task.due_date) {
          reasons.push(`截止时间: ${task.due_date}`);
          keyFactors.push('deadline');
        }
        if (task.time_effect_type === 'deadline') {
          reasons.push('截止型任务，优先安排');
          keyFactors.push('time_effect_type');
        }
        if (block.manual_signal) {
          reasons.push('用户手动调整');
          keyFactors.push('manual_signal');
        }
        if (task.locked) {
          reasons.push('已锁定，不可自动调整');
          keyFactors.push('locked');
        }
      }
    }

    return { block_id: blockId, reasons, key_factors: keyFactors };
  }

  getDaySchedule(date: string): ScheduleBlock[] {
    const rows = this.db.prepare('SELECT * FROM schedule_blocks WHERE date = ? ORDER BY start_time').all(date) as Record<string, unknown>[];
    return rows.map((r) => this.mapRowToBlock(r));
  }

  private clearDaySchedule(date: string): void {
    this.db.prepare('DELETE FROM schedule_blocks WHERE date = ? AND locked = 0').run(date);
  }

  private persistBlock(block: ScheduleBlock): void {
    this.db.prepare(`
      INSERT INTO schedule_blocks (id, task_id, event_id, date, start_time, end_time, locked, manual_signal, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      block.id,
      block.task_id,
      block.event_id,
      block.date,
      block.start_time,
      block.end_time,
      block.locked ? 1 : 0,
      block.manual_signal ? 1 : 0,
      block.created_at,
      block.updated_at,
    );
  }

  private getOccupiedSlots(date: string, blocks: ScheduleBlock[]): { start: string; end: string }[] {
    return blocks
      .filter((b) => b.date === date)
      .map((b) => ({ start: b.start_time, end: b.end_time }));
  }

  private getAvailableSlots(date: string, occupied: { start: string; end: string }[]): { start: string; end: string; remainingMinutes: number }[] {
    const workHours = this.preferenceService.getWorkHours();
    const workStart = `${date}T${workHours.start}:00`;
    const workEnd = `${date}T${workHours.end}:00`;

    const slots: { start: string; end: string; remainingMinutes: number }[] = [];
    let current = workStart;

    const sorted = [...occupied].sort((a, b) => a.start.localeCompare(b.start));

    for (const occ of sorted) {
      if (current < occ.start) {
        const start = current;
        const end = occ.start;
        const minutes = (new Date(end).getTime() - new Date(start).getTime()) / 60000;
        slots.push({ start, end, remainingMinutes: minutes });
      }
      if (occ.end > current) {
        current = occ.end;
      }
    }

    if (current < workEnd) {
      const minutes = (new Date(workEnd).getTime() - new Date(current).getTime()) / 60000;
      slots.push({ start: current, end: workEnd, remainingMinutes: minutes });
    }

    return slots;
  }

  private findSlotForTask(task: Task, slots: { start: string; end: string; remainingMinutes: number }[], date: string): { start: string; end: string } | null {
    const duration = task.duration_minutes ?? 30;
    for (const slot of slots) {
      if (slot.remainingMinutes >= duration) {
        const start = slot.start;
        const endDate = new Date(new Date(start).getTime() + duration * 60000);
        const end = endDate.toISOString();
        return { start, end };
      }
    }
    return null;
  }

  private updateAvailableSlots(slots: { start: string; end: string; remainingMinutes: number }[], used: { start: string; end: string }): void {
    for (const slot of slots) {
      if (slot.start === used.start) {
        const newStart = used.end;
        const newRemaining = (new Date(slot.end).getTime() - new Date(newStart).getTime()) / 60000;
        slot.start = newStart;
        slot.remainingMinutes = newRemaining;
        break;
      }
    }
  }

  private mapRowToBlock(row: Record<string, unknown>): ScheduleBlock {
    return {
      id: row.id as string,
      task_id: (row.task_id as string) ?? null,
      event_id: (row.event_id as string) ?? null,
      date: row.date as string,
      start_time: row.start_time as string,
      end_time: row.end_time as string,
      locked: Boolean(row.locked),
      manual_signal: Boolean(row.manual_signal),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
