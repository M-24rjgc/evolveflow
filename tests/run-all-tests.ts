import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { EvolveFlowDatabase } from '@evolveflow/storage';
import { TaskService, EventService, ScheduleService, ReminderService, ActionLogService, UndoService, SummaryService, PreferenceService, MemoryProjectionService } from '@evolveflow/domain';
import { createRegistry } from '@evolveflow/capabilities';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('Integration Tests', () => {
  let tmpDir: string;
  let dbPath: string;
  let db: EvolveFlowDatabase;
  let database: ReturnType<EvolveFlowDatabase['getDb']>;
  let taskService: TaskService;
  let eventService: EventService;
  let scheduleService: ScheduleService;
  let reminderService: ReminderService;
  let actionLogService: ActionLogService;
  let undoService: UndoService;
  let summaryService: SummaryService;
  let preferenceService: PreferenceService;
  let memoryProjectionService: MemoryProjectionService;
  let registry: ReturnType<typeof createRegistry>;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-integration-'));
    dbPath = path.join(tmpDir, 'test.db');
    db = new EvolveFlowDatabase(dbPath);
    database = db.getDb();

    taskService = new TaskService(database);
    eventService = new EventService(database);
    scheduleService = new ScheduleService(database, taskService, eventService);
    reminderService = new ReminderService(database);
    actionLogService = new ActionLogService(database);
    undoService = new UndoService(database, actionLogService);
    summaryService = new SummaryService(database, taskService);
    preferenceService = new PreferenceService(database);
    memoryProjectionService = new MemoryProjectionService(database, preferenceService);
    registry = createRegistry(db);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('Domain Service Tests', () => {
    it('TaskService: create and retrieve', () => {
      const task = taskService.create({ title: 'Integration test task' });
      const found = taskService.getById(task.id);
      expect(found).not.toBeNull();
      expect(found!.title).toBe('Integration test task');
    });

    it('TaskService: complete task', () => {
      const task = taskService.create({ title: 'Complete me' });
      const completed = taskService.complete(task.id);
      expect(completed.status).toBe('completed');
    });

    it('EventService: create and list', () => {
      const event = eventService.create({
        title: 'Test event',
        start_time: '2025-06-01T10:00:00',
        end_time: '2025-06-01T11:00:00',
      });
      const found = eventService.getById(event.id);
      expect(found).not.toBeNull();
    });

    it('ScheduleService: plan day', () => {
      const blocks = scheduleService.planDay('2025-06-01');
      expect(Array.isArray(blocks)).toBe(true);
    });

    it('ReminderService: create and snooze', () => {
      const reminder = reminderService.create(null, null, '2025-06-01T10:00:00');
      const snoozed = reminderService.snooze(reminder.id, 30);
      expect(snoozed.status).toBe('snoozed');
    });

    it('PreferenceService: set and get', () => {
      preferenceService.set('test_key', 'test_value');
      const value = preferenceService.get('test_key');
      expect(value).toBe('test_value');
    });

    it('SummaryService: generate daily', () => {
      const summary = summaryService.generateDaily('2025-06-01');
      expect(summary.date).toBe('2025-06-01');
    });
  });

  describe('Capability Layer Tests', () => {
    it('Registry: invoke task.create', async () => {
      const result = await registry.invoke('task.create', { title: 'Via registry' }, { actor: 'user', origin: 'gui' });
      expect(result.success).toBe(true);
    });

    it('Registry: idempotency', async () => {
      const ctx = { actor: 'user' as const, origin: 'gui' as const, idempotency_key: 'idem-test-1' };
      const r1 = await registry.invoke('task.create', { title: 'Idem' }, ctx);
      const r2 = await registry.invoke('task.create', { title: 'Idem' }, ctx);
      expect(r1.success).toBe(true);
      expect(r2.success).toBe(true);
    });

    it('Registry: revision increments', async () => {
      const revBefore = db.getRevision();
      await registry.invoke('task.create', { title: 'Rev test' }, { actor: 'user', origin: 'gui' });
      expect(db.getRevision()).toBeGreaterThan(revBefore);
    });

    it('Registry: unknown capability fails', async () => {
      const result = await registry.invoke('bash.run', { command: 'rm -rf /' }, { actor: 'ai', origin: 'ai_page' });
      expect(result.success).toBe(false);
    });
  });

  describe('Undo Tests', () => {
    it('Undo: revert task.create', async () => {
      const task = taskService.create({ title: 'To undo' });
      const log = actionLogService.record({
        capability: 'task.create', actor: 'ai', origin: 'ai_page',
        inputSnapshot: { title: 'To undo' }, stateBefore: {}, stateAfter: { id: task.id },
      });
      undoService.revertAction(log.id);
      expect(taskService.getById(task.id)).toBeNull();
    });
  });
});
