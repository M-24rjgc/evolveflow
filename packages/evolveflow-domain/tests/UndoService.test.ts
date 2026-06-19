import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EvolveFlowDatabase } from '@evolveflow/storage';
import { TaskService } from '../src/TaskService.js';
import { ActionLogService } from '../src/ActionLogService.js';
import { UndoService } from '../src/UndoService.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('UndoService', () => {
  let db: EvolveFlowDatabase;
  let taskService: TaskService;
  let actionLogService: ActionLogService;
  let undoService: UndoService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-test-'));
    db = new EvolveFlowDatabase(path.join(tmpDir, 'test.db'));
    taskService = new TaskService(db.getDb());
    actionLogService = new ActionLogService(db.getDb());
    undoService = new UndoService(db.getDb(), actionLogService);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should undo a task creation by deleting the task', () => {
    const task = taskService.create({ title: 'To undo' });

    const log = actionLogService.record({
      capability: 'task.create',
      actor: 'ai',
      origin: 'ai_page',
      inputSnapshot: { title: 'To undo' },
      stateBefore: {},
      stateAfter: { id: task.id, title: 'To undo', status: 'pending' },
    });

    undoService.revertAction(log.id);
    const deleted = taskService.getById(task.id);
    expect(deleted).toBeNull();
  });

  it('should undo a task completion by reverting to pending', () => {
    const task = taskService.create({ title: 'To complete then undo' });
    const beforeState = { id: task.id, title: 'To complete then undo', status: 'pending' };

    const completed = taskService.complete(task.id);
    const log = actionLogService.record({
      capability: 'task.complete',
      actor: 'ai',
      origin: 'ai_page',
      inputSnapshot: { task_id: task.id },
      stateBefore: beforeState,
      stateAfter: { id: completed.id, status: 'completed' },
    });

    undoService.revertAction(log.id);
    const reverted = taskService.getById(task.id);
    expect(reverted?.status).toBe('pending');
  });

  it('should undo a memory/dream insight update without throwing on updated_at column', () => {
    // Regression: UndoService.revertMemoryAction builds
    // `UPDATE dream_insights SET ..., updated_at = ?`, but the table only had
    // created_at until migration v3. This verifies the column now exists and
    // the revert round-trips a dream insight.
    const sqliteDb = db.getDb();
    const now = new Date().toISOString();
    sqliteDb
      .prepare(
        `INSERT INTO dream_insights (id, dream_run_id, category, insight_text, confidence, supporting_data, source_analysis, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run('dream-1', 'run-1', 'productivity', 'original insight', 0.8, '{}', '', null, now);

    // Simulate a mutation, then an action log capturing the pre-mutation row.
    sqliteDb
      .prepare(`UPDATE dream_insights SET insight_text = 'mutated' WHERE id = 'dream-1'`)
      .run();

    const log = actionLogService.record({
      capability: 'memory.update_insight',
      actor: 'ai',
      origin: 'dream',
      inputSnapshot: { id: 'dream-1' },
      stateBefore: {
        id: 'dream-1',
        dream_run_id: 'run-1',
        category: 'productivity',
        insight_text: 'original insight',
        confidence: 0.8,
        supporting_data: '{}',
        source_analysis: '',
        expires_at: null,
        created_at: now,
      },
      stateAfter: { id: 'dream-1', insight_text: 'mutated' },
    });

    expect(() => undoService.revertAction(log.id)).not.toThrow();

    const restored = sqliteDb
      .prepare('SELECT insight_text FROM dream_insights WHERE id = ?')
      .get('dream-1') as { insight_text: string };
    expect(restored.insight_text).toBe('original insight');
  });
});
