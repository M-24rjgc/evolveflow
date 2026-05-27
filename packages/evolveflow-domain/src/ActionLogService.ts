import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { ActionLog, Actor, Origin } from './types.js';

export class ActionLogService {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  record(params: {
    capability: string;
    actor: Actor;
    origin: Origin;
    idempotencyKey?: string;
    inputSnapshot: Record<string, unknown>;
    stateBefore?: Record<string, unknown>;
    stateAfter?: Record<string, unknown>;
    description?: string;
    undoGroupId?: string;
  }): ActionLog {
    const id = uuidv4();
    const now = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO action_logs (id, capability, actor, origin, idempotency_key, input_snapshot, state_before, state_after, description, undo_group_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.capability,
      params.actor,
      params.origin,
      params.idempotencyKey ?? null,
      JSON.stringify(params.inputSnapshot),
      params.stateBefore ? JSON.stringify(params.stateBefore) : null,
      params.stateAfter ? JSON.stringify(params.stateAfter) : null,
      params.description ?? null,
      params.undoGroupId ?? null,
      now,
    );

    return this.getById(id)!;
  }

  getById(id: string): ActionLog | null {
    const row = this.db.prepare('SELECT * FROM action_logs WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  list(filters?: { actor?: Actor; origin?: Origin; capability?: string; limit?: number; offset?: number }): ActionLog[] {
    let sql = 'SELECT * FROM action_logs WHERE 1=1';
    const params: unknown[] = [];
    if (filters?.actor) { sql += ' AND actor = ?'; params.push(filters.actor); }
    if (filters?.origin) { sql += ' AND origin = ?'; params.push(filters.origin); }
    if (filters?.capability) { sql += ' AND capability = ?'; params.push(filters.capability); }
    sql += ' ORDER BY created_at DESC';
    if (filters?.limit) { sql += ' LIMIT ?'; params.push(filters.limit); }
    if (filters?.offset) { sql += ' OFFSET ?'; params.push(filters.offset); }
    const rows = this.db.prepare(sql).all(...params) as Record<string, unknown>[];
    return rows.map((r) => this.mapRow(r));
  }

  getByIdempotencyKey(key: string): ActionLog | null {
    const row = this.db.prepare('SELECT * FROM action_logs WHERE idempotency_key = ?').get(key) as Record<string, unknown> | undefined;
    return row ? this.mapRow(row) : null;
  }

  private mapRow(row: Record<string, unknown>): ActionLog {
    return {
      id: row.id as string,
      capability: row.capability as string,
      actor: row.actor as Actor,
      origin: row.origin as Origin,
      idempotency_key: (row.idempotency_key as string) ?? null,
      input_snapshot: row.input_snapshot as string,
      state_before: (row.state_before as string) ?? null,
      state_after: (row.state_after as string) ?? null,
      description: (row.description as string) ?? null,
      undo_group_id: (row.undo_group_id as string) ?? null,
      created_at: row.created_at as string,
    };
  }
}
