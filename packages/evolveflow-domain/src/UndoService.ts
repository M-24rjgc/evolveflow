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
    if (!actionLog) {throw new Error(`Action log not found: ${actionLogId}`);}
    if (!actionLog.state_before && !actionLog.state_after) {
      throw new Error(`Cannot revert action: no state snapshot`);
    }

    // Idempotency check: has this action already been reverted?
    const alreadyReverted = this.db.prepare(
      "SELECT 1 FROM action_logs WHERE capability = 'undo.revert_action' AND input_snapshot LIKE ?"
    ).get(`%"actionLogId":"${actionLogId}"%`);
    if (alreadyReverted) {
      throw new Error(`Action ${actionLogId} has already been reverted`);
    }

    const stateBefore = actionLog.state_before ? JSON.parse(actionLog.state_before) as Record<string, unknown> : null;
    const stateAfter = actionLog.state_after ? JSON.parse(actionLog.state_after) as Record<string, unknown> : null;
    const capability = actionLog.capability;

    const revertTransaction = this.db.transaction(() => {
      if (capability.startsWith('task.')) {
        this.revertTaskAction(capability, stateBefore, stateAfter);
      } else if (capability.startsWith('event.')) {
        this.revertEventAction(capability, stateBefore, stateAfter);
      } else if (capability.startsWith('schedule.')) {
        if (!stateBefore) {throw new Error(`Cannot revert action: no state_before snapshot`);}
        this.revertScheduleAction(actionLogId, stateBefore);
      } else if (capability.startsWith('reminder.')) {
        if (!stateBefore) {throw new Error(`Cannot revert ${capability}: no state_before snapshot`);}
        this.revertReminderAction(capability, stateBefore);
      } else if (capability.startsWith('preference.')) {
        if (!stateBefore) {throw new Error(`Cannot revert ${capability}: no state_before snapshot`);}
        this.revertPreferenceAction(stateBefore);
      } else if (capability.startsWith('memory.')) {
        if (!stateBefore) {throw new Error(`Cannot revert ${capability}: no state_before snapshot`);}
        this.revertMemoryAction(capability, stateBefore);
      } else {
        throw new Error(`Unsupported undo capability: ${capability}. No revert handler registered for this capability type.`);
      }

      // Record the revert so idempotency checks work for subsequent calls
      const undoGroupId = uuidv4();
      const now = new Date().toISOString();
      this.db.prepare('INSERT INTO undo_groups (id, description, created_at) VALUES (?, ?, ?)').run(
        undoGroupId,
        `Reverted: ${capability}`,
        now,
      );
      this.db.prepare('UPDATE action_logs SET undo_group_id = ? WHERE id = ?').run(undoGroupId, actionLogId);

      // Log the revert as an action_log entry so idempotency checks can find it
      this.db.prepare(`
        INSERT INTO action_logs (id, capability, actor, origin, idempotency_key, input_snapshot, state_before, state_after, description, undo_group_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(),
        'undo.revert_action',
        'system',
        'cli',
        null,
        JSON.stringify({ actionLogId }),
        null,
        null,
        `Reverted action: ${capability}`,
        undoGroupId,
        now,
      );
    });
    revertTransaction();

    return true;
  }

  private coerceValueForSql(value: unknown): unknown {
    if (typeof value === 'boolean') {
      return value ? 1 : 0;
    }
    return value;
  }

  private revertTaskAction(capability: string, stateBefore: Record<string, unknown> | null, stateAfter: Record<string, unknown> | null): void {
    const now = new Date().toISOString();
    if (capability === 'task.create') {
      const taskId = stateAfter?.id as string | undefined;
      if (!taskId) {throw new Error(`Cannot revert task.create: no created task id`);}
      this.db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId);
      this.db.prepare('DELETE FROM tasks WHERE id = ?').run(taskId);
    } else if (capability === 'task.update' || capability === 'task.complete' || capability === 'task.defer' || capability === 'task.lock') {
      if (!stateBefore) {throw new Error(`Cannot revert ${capability}: no state_before snapshot`);}
      const taskId = stateBefore.id as string;
      // Exclude 'updated_at' from stateBefore fields to avoid duplicate SET clause
      const fields = Object.keys(stateBefore).filter((k) => k !== 'tags' && k !== 'updated_at');
      const sets = fields.map((k) => `${k} = ?`).join(', ');
      const values = fields.map((k) => this.coerceValueForSql(stateBefore[k]));
      values.push(now, taskId);
      this.db.prepare(`UPDATE tasks SET ${sets}, updated_at = ? WHERE id = ?`).run(...values);
      this.restoreTaskTags(taskId, stateBefore.tags);
    }
  }

  private revertEventAction(capability: string, stateBefore: Record<string, unknown> | null, stateAfter: Record<string, unknown> | null): void {
    const now = new Date().toISOString();
    if (capability === 'event.create') {
      const eventId = stateAfter?.id as string | undefined;
      if (!eventId) {throw new Error(`Cannot revert event.create: no created event id`);}
      this.db.prepare('DELETE FROM events WHERE id = ?').run(eventId);
    } else if (capability === 'event.update' || capability === 'event.lock') {
      if (!stateBefore) {throw new Error(`Cannot revert ${capability}: no state_before snapshot`);}
      const eventId = stateBefore.id as string;
      // Exclude 'updated_at' from stateBefore fields to avoid duplicate SET clause
      const fields = Object.keys(stateBefore).filter((k) => k !== 'updated_at');
      const sets = fields.map((k) => `${k} = ?`).join(', ');
      const values = fields.map((k) => this.coerceValueForSql(stateBefore[k]));
      values.push(now, eventId);
      this.db.prepare(`UPDATE events SET ${sets}, updated_at = ? WHERE id = ?`).run(...values);
    }
  }

  private revertReminderAction(capability: string, stateBefore: Record<string, unknown>): void {
    const now = new Date().toISOString();
    if (capability === 'reminder.dismiss' || capability === 'reminder.snooze' || capability === 'reminder.create') {
      const reminderId = stateBefore.id as string;
      if (!reminderId) {throw new Error(`Cannot revert ${capability}: no reminder id in state_before`);}
      // Restore all fields from stateBefore, excluding updated_at
      const fields = Object.keys(stateBefore).filter((k) => k !== 'updated_at');
      const sets = fields.map((k) => `${k} = ?`).join(', ');
      const values = fields.map((k) => this.coerceValueForSql(stateBefore[k]));
      values.push(now, reminderId);
      this.db.prepare(`UPDATE reminders SET ${sets}, updated_at = ? WHERE id = ?`).run(...values);
    }
  }

  private revertPreferenceAction(stateBefore: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const key = stateBefore.key as string;
    const value = stateBefore.value as string;
    if (key !== undefined && value !== undefined) {
      this.db.prepare('INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, ?)').run(key, value, now);
    }
  }

  private revertMemoryAction(capability: string, stateBefore: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const memoryId = stateBefore.id as string;
    if (!memoryId) {throw new Error(`Cannot revert ${capability}: no memory id in state_before`);}
    // Restore all fields from stateBefore, excluding updated_at
    const fields = Object.keys(stateBefore).filter((k) => k !== 'updated_at');
    const sets = fields.map((k) => `${k} = ?`).join(', ');
    const values = fields.map((k) => this.coerceValueForSql(stateBefore[k]));
    values.push(now, memoryId);
    this.db.prepare(`UPDATE dream_insights SET ${sets}, updated_at = ? WHERE id = ?`).run(...values);
  }

  private restoreTaskTags(taskId: string, tags: unknown): void {
    this.db.prepare('DELETE FROM task_tags WHERE task_id = ?').run(taskId);
    if (!Array.isArray(tags)) {return;}
    const tagStmt = this.db.prepare('INSERT INTO task_tags (task_id, tag) VALUES (?, ?)');
    for (const tag of tags) {
      if (typeof tag === 'string') {tagStmt.run(taskId, tag);}
    }
  }

  private revertScheduleAction(actionLogId: string, stateBefore: Record<string, unknown>): void {
    const now = new Date().toISOString();
    const date = stateBefore.date as string | undefined;
    if (date) {
      this.db.prepare('DELETE FROM schedule_blocks WHERE date = ? AND locked = 0 AND manual_signal = 0').run(date);
      if (stateBefore.blocks) {
        let blocks: Record<string, unknown>[];
        try {
          blocks = JSON.parse(stateBefore.blocks as string) as Record<string, unknown>[];
        } catch (e) {
          throw new Error(`Cannot revert schedule action ${actionLogId}: invalid JSON in stateBefore.blocks: ${(e as Error).message}`);
        }
        for (const block of blocks) {
          this.db.prepare(`
            INSERT INTO schedule_blocks (id, task_id, event_id, date, start_time, end_time, locked, manual_signal, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            block.id, block.task_id, block.event_id, block.date,
            block.start_time, block.end_time,
            typeof block.locked === 'boolean' ? (block.locked ? 1 : 0) : block.locked,
            typeof block.manual_signal === 'boolean' ? (block.manual_signal ? 1 : 0) : block.manual_signal,
            now, now,
          );
        }
      }
    }
  }
}
