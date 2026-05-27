import { EvolveFlowDatabase } from '@evolveflow/storage';
import { TaskService } from '../src/TaskService.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

let db: EvolveFlowDatabase;
let taskService: TaskService;
let tmpDir: string;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-test-'));
  db = new EvolveFlowDatabase(path.join(tmpDir, 'test.db'));
  taskService = new TaskService(db.getDb());
}

function teardown() {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function testCreateTask() {
  setup();
  try {
    const task = taskService.create({ title: 'Test task' });
    assert(task.id.length > 0, 'Task should have an id');
    assert(task.title === 'Test task', 'Task title should match');
    assert(task.status === 'pending', 'Task status should be pending');
    assert(task.locked === false, 'Task should not be locked');
    console.log('  ✅ testCreateTask passed');
  } finally {
    teardown();
  }
}

function testCreateTaskWithPartialInfo() {
  setup();
  try {
    const task = taskService.create({ title: 'Partial task' });
    assert(task.duration_minutes === null, 'Duration should be null');
    assert(task.due_date === null, 'Due date should be null');
    console.log('  ✅ testCreateTaskWithPartialInfo passed');
  } finally {
    teardown();
  }
}

function testCompleteTask() {
  setup();
  try {
    const task = taskService.create({ title: 'To complete' });
    const completed = taskService.complete(task.id);
    assert(completed.status === 'completed', 'Task should be completed');
    console.log('  ✅ testCompleteTask passed');
  } finally {
    teardown();
  }
}

function testDeferTask() {
  setup();
  try {
    const task = taskService.create({ title: 'To defer' });
    const deferred = taskService.defer(task.id, '2025-12-31');
    assert(deferred.status === 'deferred', 'Task should be deferred');
    console.log('  ✅ testDeferTask passed');
  } finally {
    teardown();
  }
}

function testLockTask() {
  setup();
  try {
    const task = taskService.create({ title: 'To lock' });
    const locked = taskService.lock(task.id, true);
    assert(locked.locked === true, 'Task should be locked');
    const unlocked = taskService.lock(task.id, false);
    assert(unlocked.locked === false, 'Task should be unlocked');
    console.log('  ✅ testLockTask passed');
  } finally {
    teardown();
  }
}

function testUpdateLockedTaskFails() {
  setup();
  try {
    const task = taskService.create({ title: 'Locked task' });
    taskService.lock(task.id, true);
    let errorCaught = false;
    try {
      taskService.update({ task_id: task.id, title: 'New title' });
    } catch (e) {
      errorCaught = true;
    }
    assert(errorCaught, 'Should throw error when updating locked task');
    console.log('  ✅ testUpdateLockedTaskFails passed');
  } finally {
    teardown();
  }
}

function testSubTasks() {
  setup();
  try {
    const parent = taskService.create({ title: 'Parent' });
    const child1 = taskService.create({ title: 'Child 1', parent_task_id: parent.id });
    const child2 = taskService.create({ title: 'Child 2', parent_task_id: parent.id });
    const subs = taskService.getSubTasks(parent.id);
    assert(subs.length === 2, 'Should have 2 subtasks');
    console.log('  ✅ testSubTasks passed');
  } finally {
    teardown();
  }
}

function testListTasks() {
  setup();
  try {
    taskService.create({ title: 'Task 1' });
    taskService.create({ title: 'Task 2' });
    taskService.create({ title: 'Task 3' });
    const all = taskService.list();
    assert(all.length === 3, 'Should have 3 tasks');
    const pending = taskService.list({ status: 'pending' });
    assert(pending.length === 3, 'Should have 3 pending tasks');
    console.log('  ✅ testListTasks passed');
  } finally {
    teardown();
  }
}

console.log('\n🧪 TaskService Tests:');
testCreateTask();
testCreateTaskWithPartialInfo();
testCompleteTask();
testDeferTask();
testLockTask();
testUpdateLockedTaskFails();
testSubTasks();
testListTasks();
console.log('  All TaskService tests passed!\n');
