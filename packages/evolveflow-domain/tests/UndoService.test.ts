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
});
