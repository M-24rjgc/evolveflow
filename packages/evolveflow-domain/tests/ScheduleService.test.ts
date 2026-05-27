import { EvolveFlowDatabase } from '@evolveflow/storage';
import { TaskService } from '../src/TaskService.js';
import { EventService } from '../src/EventService.js';
import { ScheduleService } from '../src/ScheduleService.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

let db: EvolveFlowDatabase;
let taskService: TaskService;
let eventService: EventService;
let scheduleService: ScheduleService;
let tmpDir: string;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-test-'));
  db = new EvolveFlowDatabase(path.join(tmpDir, 'test.db'));
  taskService = new TaskService(db.getDb());
  eventService = new EventService(db.getDb());
  scheduleService = new ScheduleService(db.getDb(), taskService, eventService);
}

function teardown() {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function testPlanDayWithNoItems() {
  setup();
  try {
    const blocks = scheduleService.planDay('2025-06-01');
    assert(blocks.length === 0, 'Should have no blocks with no tasks/events');
    console.log('  ✅ testPlanDayWithNoItems passed');
  } finally {
    teardown();
  }
}

function testPlanDayWithEvent() {
  setup();
  try {
    eventService.create({
      title: 'Meeting',
      start_time: '2025-06-01T10:00:00',
      end_time: '2025-06-01T11:00:00',
    });
    const blocks = scheduleService.planDay('2025-06-01');
    assert(blocks.length === 1, 'Should have 1 block for event');
    assert(blocks[0].event_id !== null, 'Block should reference event');
    console.log('  ✅ testPlanDayWithEvent passed');
  } finally {
    teardown();
  }
}

function testPlanDayWithTask() {
  setup();
  try {
    taskService.create({ title: 'Work', duration_minutes: 60 });
    const blocks = scheduleService.planDay('2025-06-01');
    assert(blocks.length >= 1, 'Should have at least 1 block for task');
    console.log('  ✅ testPlanDayWithTask passed');
  } finally {
    teardown();
  }
}

function testLockedTaskNotRescheduled() {
  setup();
  try {
    const task = taskService.create({ title: 'Locked', duration_minutes: 60 });
    taskService.lock(task.id, true);
    const blocks = scheduleService.planDay('2025-06-01');
    const taskBlock = blocks.find((b) => b.task_id === task.id);
    assert(taskBlock === undefined, 'Locked task should not be auto-scheduled');
    console.log('  ✅ testLockedTaskNotRescheduled passed');
  } finally {
    teardown();
  }
}

function testExplainSchedule() {
  setup();
  try {
    eventService.create({
      title: 'Standup',
      start_time: '2025-06-01T09:00:00',
      end_time: '2025-06-01T09:30:00',
    });
    const blocks = scheduleService.planDay('2025-06-01');
    if (blocks.length > 0) {
      const explanation = scheduleService.explain(blocks[0].id);
      assert(explanation !== null, 'Should return explanation');
      assert(explanation!.reasons.length > 0, 'Should have at least one reason');
    }
    console.log('  ✅ testExplainSchedule passed');
  } finally {
    teardown();
  }
}

console.log('\n🧪 ScheduleService Tests:');
testPlanDayWithNoItems();
testPlanDayWithEvent();
testPlanDayWithTask();
testLockedTaskNotRescheduled();
testExplainSchedule();
console.log('  All ScheduleService tests passed!\n');
