import { EvolveFlowDatabase } from '@evolveflow/storage';
import { TaskService, EventService, ScheduleService, ReminderService, ActionLogService, UndoService, SummaryService, PreferenceService, MemoryProjectionService } from '@evolveflow/domain';
import { createRegistry } from '@evolveflow/capabilities';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function runTest(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ❌ ${name}: ${(e as Error).message}`);
    failed++;
  }
}

async function main() {
  console.log('\n🧪 EvolveFlow v1 Integration Tests\n');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-integration-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new EvolveFlowDatabase(dbPath);
  const database = db.getDb();

  const taskService = new TaskService(database);
  const eventService = new EventService(database);
  const scheduleService = new ScheduleService(database, taskService, eventService);
  const reminderService = new ReminderService(database);
  const actionLogService = new ActionLogService(database);
  const undoService = new UndoService(database, actionLogService);
  const summaryService = new SummaryService(database, taskService);
  const preferenceService = new PreferenceService(database);
  const memoryProjectionService = new MemoryProjectionService(database, preferenceService);
  const registry = createRegistry(db);

  console.log('📋 Domain Service Tests:');
  await runTest('TaskService: create and retrieve', async () => {
    const task = taskService.create({ title: 'Integration test task' });
    const found = taskService.getById(task.id);
    assert(found !== null, 'Should find created task');
    assert(found!.title === 'Integration test task', 'Title should match');
  });

  await runTest('TaskService: complete task', async () => {
    const task = taskService.create({ title: 'Complete me' });
    const completed = taskService.complete(task.id);
    assert(completed.status === 'completed', 'Should be completed');
  });

  await runTest('EventService: create and list', async () => {
    const event = eventService.create({ title: 'Test event', start_time: '2025-06-01T10:00:00', end_time: '2025-06-01T11:00:00' });
    const found = eventService.getById(event.id);
    assert(found !== null, 'Should find created event');
  });

  await runTest('ScheduleService: plan day', async () => {
    const blocks = scheduleService.planDay('2025-06-01');
    assert(Array.isArray(blocks), 'Should return array');
  });

  await runTest('ReminderService: create and snooze', async () => {
    const reminder = reminderService.create(null, null, '2025-06-01T10:00:00');
    const snoozed = reminderService.snooze(reminder.id, 30);
    assert(snoozed.status === 'snoozed', 'Should be snoozed');
  });

  await runTest('PreferenceService: set and get', async () => {
    preferenceService.set('test_key', 'test_value');
    const value = preferenceService.get('test_key');
    assert(value === 'test_value', 'Should retrieve set value');
  });

  await runTest('SummaryService: generate daily', async () => {
    const summary = summaryService.generateDaily('2025-06-01');
    assert(summary.date === '2025-06-01', 'Date should match');
  });

  console.log('\n📋 Capability Layer Tests:');
  await runTest('Registry: invoke task.create', async () => {
    const result = await registry.invoke('task.create', { title: 'Via registry' }, { actor: 'user', origin: 'gui' });
    assert(result.success === true, 'Should succeed');
  });

  await runTest('Registry: idempotency', async () => {
    const ctx = { actor: 'user' as const, origin: 'gui' as const, idempotency_key: 'idem-test-1' };
    const r1 = await registry.invoke('task.create', { title: 'Idem' }, ctx);
    const r2 = await registry.invoke('task.create', { title: 'Idem' }, ctx);
    assert(r1.success && r2.success, 'Both should succeed (cached)');
  });

  await runTest('Registry: revision increments', async () => {
    const revBefore = db.getRevision();
    await registry.invoke('task.create', { title: 'Rev test' }, { actor: 'user', origin: 'gui' });
    assert(db.getRevision() > revBefore, 'Revision should increment');
  });

  await runTest('Registry: unknown capability fails', async () => {
    const result = await registry.invoke('bash.run', { command: 'rm -rf /' }, { actor: 'ai', origin: 'ai_page' });
    assert(result.success === false, 'Should reject unknown capability');
  });

  console.log('\n📋 Undo Tests:');
  await runTest('Undo: revert task.create', async () => {
    const task = taskService.create({ title: 'To undo' });
    const log = actionLogService.record({
      capability: 'task.create', actor: 'ai', origin: 'ai_page',
      inputSnapshot: { title: 'To undo' }, stateBefore: {}, stateAfter: { id: task.id },
    });
    undoService.revertAction(log.id);
    assert(taskService.getById(task.id) === null, 'Task should be deleted');
  });

  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });

  console.log(`\n📊 Results: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
