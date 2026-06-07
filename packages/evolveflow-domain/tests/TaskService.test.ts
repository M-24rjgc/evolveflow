import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EvolveFlowDatabase } from '@evolveflow/storage';
import { TaskService } from '../src/TaskService.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('TaskService', () => {
  let db: EvolveFlowDatabase;
  let taskService: TaskService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-test-'));
    db = new EvolveFlowDatabase(path.join(tmpDir, 'test.db'));
    taskService = new TaskService(db.getDb());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create a task with default values', () => {
    const task = taskService.create({ title: 'Test task' });

    expect(task).toBeDefined();
    expect(task.id.length).toBeGreaterThan(0);
    expect(task.title).toBe('Test task');
    expect(task.status).toBe('pending');
    expect(task.locked).toBe(false);
  });

  it('should create a task with partial info', () => {
    const task = taskService.create({ title: 'Partial task' });

    expect(task.duration_minutes).toBeNull();
    expect(task.due_date).toBeNull();
  });

  it('should complete a task', () => {
    const task = taskService.create({ title: 'To complete' });
    const completed = taskService.complete(task.id);

    expect(completed.status).toBe('completed');
  });

  it('should defer a task', () => {
    const task = taskService.create({ title: 'To defer' });
    const deferred = taskService.defer(task.id, '2025-12-31');

    expect(deferred.status).toBe('deferred');
  });

  it('should lock and unlock a task', () => {
    const task = taskService.create({ title: 'To lock' });

    const locked = taskService.lock(task.id, true);
    expect(locked.locked).toBe(true);

    const unlocked = taskService.lock(task.id, false);
    expect(unlocked.locked).toBe(false);
  });

  it('should throw when updating a locked task', () => {
    const task = taskService.create({ title: 'Locked task' });
    taskService.lock(task.id, true);

    expect(() => {
      taskService.update({ task_id: task.id, title: 'New title' });
    }).toThrow();
  });

  it('should manage subtasks', () => {
    const parent = taskService.create({ title: 'Parent' });
    const child1 = taskService.create({ title: 'Child 1', parent_task_id: parent.id });
    const child2 = taskService.create({ title: 'Child 2', parent_task_id: parent.id });

    const subs = taskService.getSubTasks(parent.id);
    expect(subs.length).toBe(2);
  });

  it('should list tasks with optional filters', () => {
    taskService.create({ title: 'Task 1' });
    taskService.create({ title: 'Task 2' });
    taskService.create({ title: 'Task 3' });

    const all = taskService.list();
    expect(all.length).toBe(3);

    const pending = taskService.list({ status: 'pending' });
    expect(pending.length).toBe(3);
  });
});
