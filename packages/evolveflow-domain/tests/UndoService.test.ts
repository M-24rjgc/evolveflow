import { EvolveFlowDatabase } from '@evolveflow/storage';
import { TaskService } from '../src/TaskService.js';
import { ActionLogService } from '../src/ActionLogService.js';
import { UndoService } from '../src/UndoService.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

let db: EvolveFlowDatabase;
let taskService: TaskService;
let actionLogService: ActionLogService;
let undoService: UndoService;
let tmpDir: string;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-test-'));
  db = new EvolveFlowDatabase(path.join(tmpDir, 'test.db'));
  taskService = new TaskService(db.getDb());
  actionLogService = new ActionLogService(db.getDb());
  undoService = new UndoService(db.getDb(), actionLogService);
}

function teardown() {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function testUndoTaskCreate() {
  setup();
  try {
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
    assert(deleted === null, 'Task should be deleted after undo');
    console.log('  ✅ testUndoTaskCreate passed');
  } finally {
    teardown();
  }
}

function testUndoTaskComplete() {
  setup();
  try {
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
    assert(reverted?.status === 'pending', 'Task should be back to pending');
    console.log('  ✅ testUndoTaskComplete passed');
  } finally {
    teardown();
  }
}

console.log('\n🧪 UndoService Tests:');
testUndoTaskCreate();
testUndoTaskComplete();
console.log('  All UndoService tests passed!\n');
