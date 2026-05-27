import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { ActionLog } from './types.js';
import { ActionLogService } from './ActionLogService.js';

export class UndoService {
  private db: Database.Database;
  private actionLogService: ActionLogService;

  constructor(db: Database.Database, actionLogService: ActionLogService) {
    this.db = db;
    this.actionLogService = actionLogService;
  }

  revertAction(actionLogId: string): boolean {
    const actionLog = this.actionLogService.getById(actionLogId);
    if (!actionLog) throw new Error(`Action log not found: ${actionLogId}`);
    if (!actionLog.state_before) throw new Error(`Cannot revert action: no state_before snapshot`);

    const stateBefore = JSON.parse(actionLog.state_before) as Record<string, unknown>;
    const capability = actionLog.capability;

    const revertTransaction = this.db.transaction(() => {
      if (capability.startsWith('task.')) {
        this.revertTaskAction(capability, stateBefore);
      } else if (capability.startsWith('event.')) {
        this.revertEventAction(capability, stateBefore);
      } else if (capability.startsWith('schedule.')) {
        this.revertScheduleAction(actionLogId, stateBefore);
      }

      const undoGroupId = uuidv4();
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO undo_groups (id, description, created_at) VALUES (?, ?, ?)').run(
        undoGroupId,
        `Reverted: ${capability}`,
        now,
      );
      this.db.prepare('UPDATE action_logs SET undo_group_id = ? WHERE id = ?').run(undoGroupId, actionLogId);
    });
    revertTransaction();

    return true;
  }

  private revertTaskAction(capability: string, stateBefore: Record<string, unknown>): void {
    const taskId = stateBefore.id as string;
    const now = new Date().toISOString();
    if (capability === 'task.create') {
      this.db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    } else if (capability === 'task.update' || capability === 'task.complete' || capability === 'task.defer' || capability === 'task.lock') {
      const fields = Object.keys(stateBefore).filter((k) => k !== 'tags');
      const sets = fields.map((k) => `${k} = ?`).join(', ');
      const values = fields.map((k) => stateBefore[k]);
      values.push(now, taskId);
      this.db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...values);
    }
  }

  private revertEventAction(capability: string, stateBefore: Record<string, unknown>): void {
    const eventId = stateBefore.id as string;
    const now = new Date().toISOString();
    if (capability === 'event.create') {
      this.db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
    } else if (capability === 'event.update' || capability === 'event.lock') {
      const fields = Object.keys(stateBefore);
      const sets = fields.map((k) => `${k} = ?`).join(', ');
      const values = fields.map((k) => stateBefore[k]);
      values.push(now, eventId);
      this.db.prepare(`UPDATE events SET ${sets}, updated_at = ? WHERE id = ?`).run(...values);
    }
  }

  private revertScheduleAction(actionLogId: string, stateBefore: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const date = stateBefore.date as string | undefined;
    if (date) {
      this.db.prepare('DELETE FROM schedule_blocks WHERE date = ? AND locked = 0').run(date);
      if (stateBefore.blocks) {
        const blocks = JSON.parse(stateBefore.blocks as string) as Record<string, unknown>[];
        for (const block of blocks) {
          this.db.prepare(`
            INSERT INTO schedule_blocks (id, task_id, event_id, date, start_time, end_time, locked, manual_signal, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            block.id, block.task_id, block.event_id, block.date,
            block.start_time, block.end_time, block.locked ? 1 : 0,
            block.manual_signal ? 1 : 0, now, now,
          );
        }
      }
    }
  }
}
