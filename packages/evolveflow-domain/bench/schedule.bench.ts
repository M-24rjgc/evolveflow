import { bench, describe } from 'vitest';
import Database from 'better-sqlite3';
import { TaskService, EventService, PreferenceService, ScheduleService } from '../src/index.js';
import type { Task, Event } from '../src/types.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Create an in-memory database with all required schema.
 */
function createTestDb(): Database.Database {
  const db = new Database(':memory:');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      duration_minutes INTEGER,
      due_date TEXT,
      time_effect_type TEXT DEFAULT 'continuous',
      status TEXT DEFAULT 'pending',
      locked INTEGER DEFAULT 0,
      parent_task_id TEXT,
      project TEXT,
      tags TEXT DEFAULT '[]',
      sort_order INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      locked INTEGER DEFAULT 0,
      bound_task_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS preferences (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS schedule_blocks (
      id TEXT PRIMARY KEY,
      task_id TEXT,
      event_id TEXT,
      date TEXT NOT NULL,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      locked INTEGER DEFAULT 0,
      manual_signal INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  return db;
}

function insertTask(
  db: Database.Database,
  overrides: Partial<Task> = {},
): Task {
  const id = overrides.id ?? `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const task: Task = {
    id,
    title: overrides.title ?? `Task ${id.slice(0, 8)}`,
    description: overrides.description ?? '',
    duration_minutes: overrides.duration_minutes ?? 30,
    due_date: overrides.due_date ?? null,
    time_effect_type: overrides.time_effect_type ?? 'continuous',
    status: overrides.status ?? 'pending',
    locked: overrides.locked ?? false,
    parent_task_id: overrides.parent_task_id ?? null,
    project: overrides.project ?? null,
    tags: overrides.tags ?? [],
    sort_order: overrides.sort_order ?? 0,
    created_at: overrides.created_at ?? new Date().toISOString(),
    updated_at: overrides.updated_at ?? new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO tasks (id, title, description, duration_minutes, due_date, time_effect_type, status, locked, parent_task_id, project, tags, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    task.id, task.title, task.description, task.duration_minutes, task.due_date,
    task.time_effect_type, task.status, task.locked ? 1 : 0,
    task.parent_task_id, task.project, JSON.stringify(task.tags),
    task.sort_order, task.created_at, task.updated_at,
  );

  return task;
}

function insertEvent(
  db: Database.Database,
  date: string,
  overrides: Partial<Event> = {},
): Event {
  const id = overrides.id ?? `event_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startHour = overrides.start_time
    ? parseInt(overrides.start_time.split('T')[1]?.split(':')[0] ?? '10')
    : 10;
  const event: Event = {
    id,
    title: overrides.title ?? `Event ${id.slice(0, 8)}`,
    description: overrides.description ?? '',
    start_time: overrides.start_time ?? `${date}T${String(startHour).padStart(2, '0')}:00:00`,
    end_time: overrides.end_time ?? `${date}T${String(startHour + 1).padStart(2, '0')}:00:00`,
    locked: overrides.locked ?? false,
    bound_task_id: overrides.bound_task_id ?? null,
    created_at: overrides.created_at ?? new Date().toISOString(),
    updated_at: overrides.updated_at ?? new Date().toISOString(),
  };

  db.prepare(`
    INSERT INTO events (id, title, description, start_time, end_time, locked, bound_task_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    event.id, event.title, event.description, event.start_time, event.end_time,
    event.locked ? 1 : 0, event.bound_task_id, event.created_at, event.updated_at,
  );

  return event;
}

/**
 * Build a ScheduleService with a fresh in-memory database populated with
 * `taskCount` random pending tasks and 3 fixed events.
 */
function createScheduler(taskCount: number, date: string): ScheduleService {
  const db = createTestDb();
  const taskService = new TaskService(db);
  const eventService = new EventService(db);
  const preferenceService = new PreferenceService(db);

  // Set work hours preference
  preferenceService.set('work_hours_start', '09:00');
  preferenceService.set('work_hours_end', '18:00');

  // Insert fixed events to create realistic occupied slots
  insertEvent(db, date, {
    title: 'Standup',
    start_time: `${date}T09:00:00`,
    end_time: `${date}T09:30:00`,
  });
  insertEvent(db, date, {
    title: 'Lunch',
    start_time: `${date}T12:00:00`,
    end_time: `${date}T13:00:00`,
  });
  insertEvent(db, date, {
    title: 'End-of-day review',
    start_time: `${date}T17:00:00`,
    end_time: `${date}T17:30:00`,
  });

  // Insert tasks with varying durations, due-dates, and types
  const types: Array<'continuous' | 'deadline' | 'event_bound'> = [
    'continuous', 'deadline', 'event_bound',
  ];

  for (let i = 0; i < taskCount; i++) {
    const duration = [15, 30, 45, 60, 90, 120][i % 6];
    const type = types[i % 3];

    insertTask(db, {
      title: `Benchmark Task ${i + 1}`,
      duration_minutes: duration,
      time_effect_type: type,
      due_date: type === 'deadline' ? date : (i % 2 === 0 ? date : null),
      project: ['work', 'personal', 'health'][i % 3],
      tags: i % 2 === 0 ? ['important'] : [],
    });
  }

  return new ScheduleService(db, taskService, eventService, preferenceService);
}

// ── Benchmarks ────────────────────────────────────────────────────────────

const BENCH_DATE = '2026-05-29';

describe('ScheduleService.planDayOptimized', () => {
  bench('planDayOptimized with 10 tasks', () => {
    const scheduler = createScheduler(10, BENCH_DATE);
    scheduler.planDayOptimized(BENCH_DATE);
  });

  bench('planDayOptimized with 50 tasks', () => {
    const scheduler = createScheduler(50, BENCH_DATE);
    scheduler.planDayOptimized(BENCH_DATE);
  });

  bench('planDayOptimized with 100 tasks', () => {
    const scheduler = createScheduler(100, BENCH_DATE);
    scheduler.planDayOptimized(BENCH_DATE);
  });
});

describe('ScheduleService.planRange', () => {
  bench('planRange with 7-day range and 200 tasks', () => {
    // Create scheduler with 200 tasks across the first date
    const scheduler = createScheduler(200, BENCH_DATE);
    const endDate = new Date(BENCH_DATE);
    endDate.setDate(endDate.getDate() + 6);
    const endStr = endDate.toISOString().split('T')[0];
    scheduler.planRange(BENCH_DATE, endStr);
  });
});

describe('ScheduleService.rebalance', () => {
  bench('rebalance with 50 tasks', () => {
    const scheduler = createScheduler(50, BENCH_DATE);
    // First schedule some blocks so rebalance has work to do
    scheduler.planDayOptimized(BENCH_DATE);
    // Now rebalance
    scheduler.rebalance(BENCH_DATE);
  });
});
