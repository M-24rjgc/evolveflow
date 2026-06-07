import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EvolveFlowDatabase } from '@evolveflow/storage';
import { TaskService } from '../src/TaskService.js';
import { EventService } from '../src/EventService.js';
import { ScheduleService } from '../src/ScheduleService.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('ScheduleService', () => {
  let db: EvolveFlowDatabase;
  let taskService: TaskService;
  let eventService: EventService;
  let scheduleService: ScheduleService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-test-'));
    db = new EvolveFlowDatabase(path.join(tmpDir, 'test.db'));
    taskService = new TaskService(db.getDb());
    eventService = new EventService(db.getDb());
    scheduleService = new ScheduleService(db.getDb(), taskService, eventService);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should plan a day with no items returning empty blocks', () => {
    const blocks = scheduleService.planDay('2025-06-01');

    expect(blocks.length).toBe(0);
  });

  it('should plan a day with an event', () => {
    eventService.create({
      title: 'Meeting',
      start_time: '2025-06-01T10:00:00',
      end_time: '2025-06-01T11:00:00',
    });

    const blocks = scheduleService.planDay('2025-06-01');
    expect(blocks.length).toBe(1);
    expect(blocks[0].event_id).not.toBeNull();
  });

  it('should plan a day with a task', () => {
    taskService.create({ title: 'Work', duration_minutes: 60 });

    const blocks = scheduleService.planDay('2025-06-01');
    expect(blocks.length).toBeGreaterThanOrEqual(1);
  });

  it('should not reschedule a locked task', () => {
    const task = taskService.create({ title: 'Locked', duration_minutes: 60 });
    taskService.lock(task.id, true);

    const blocks = scheduleService.planDay('2025-06-01');
    const taskBlock = blocks.find((b) => b.task_id === task.id);
    expect(taskBlock).toBeUndefined();
  });

  it('should provide schedule explanation', () => {
    eventService.create({
      title: 'Standup',
      start_time: '2025-06-01T09:00:00',
      end_time: '2025-06-01T09:30:00',
    });

    const blocks = scheduleService.planDay('2025-06-01');
    if (blocks.length > 0) {
      const explanation = scheduleService.explain(blocks[0].id);
      expect(explanation).not.toBeNull();
      expect(explanation!.reasons.length).toBeGreaterThan(0);
    }
  });

  it('should not duplicate locked event blocks on repeated planning', () => {
    const event = eventService.create({
      title: 'Locked meeting',
      start_time: '2025-06-01T10:00:00',
      end_time: '2025-06-01T11:00:00',
    });
    eventService.lock(event.id, true);

    scheduleService.planDay('2025-06-01');
    scheduleService.planDay('2025-06-01');

    const eventBlocks = scheduleService
      .getDaySchedule('2025-06-01')
      .filter((block) => block.event_id === event.id);
    expect(eventBlocks).toHaveLength(1);
    expect(eventBlocks[0].locked).toBe(true);
  });

  it('should keep manual blocks occupied during replanning', () => {
    const now = new Date().toISOString();
    const manualBlockId = 'manual-block-1';
    db.getDb()
      .prepare(
        `INSERT INTO schedule_blocks
          (id, task_id, event_id, date, start_time, end_time, locked, manual_signal, created_at, updated_at)
         VALUES (?, NULL, NULL, ?, ?, ?, 0, 1, ?, ?)`,
      )
      .run(
        manualBlockId,
        '2025-06-01',
        '2025-06-01T09:00:00',
        '2025-06-01T10:00:00',
        now,
        now,
      );
    const task = taskService.create({ title: 'Focused work', duration_minutes: 60 });

    const blocks = scheduleService.planDay('2025-06-01');
    const manualBlock = blocks.find((block) => block.id === manualBlockId);
    const taskBlock = blocks.find((block) => block.task_id === task.id);

    expect(manualBlock).toBeDefined();
    expect(taskBlock).toBeDefined();
    expect(
      taskBlock!.end_time <= manualBlock!.start_time ||
        taskBlock!.start_time >= manualBlock!.end_time,
    ).toBe(true);
  });
});
