/**
 * EvolveFlow context injection for AI conversations.
 *
 * Builds a rich ConversationContext object that is injected into
 * every AI system prompt, giving the agent full awareness of:
 *  - Current date/time and user work schedule
 *  - Today's tasks, events, and schedule blocks
 *  - Overdue items needing attention
 *  - User preferences and dream-learned insights
 *  - Reminder state
 *
 * This is the key to "coordinated evolution": the AI learns about the user
 * from their actual data, not just from the conversation.
 */

import type { ConversationContext } from './types.js';
import type { EvolveFlowDatabase } from '@evolveflow/storage';
import type { CapabilityRegistry } from '@evolveflow/capabilities';

// Internal Types

interface QueryResult<T> {
  items: T[];
  hiddenCount: number;
}

function formatLocalDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Main Context Builder

export async function buildConversationContext(
  db: EvolveFlowDatabase,
  registry: CapabilityRegistry,
  options?: {
    maxTodayTasks?: number;
    maxTodayEvents?: number;
    maxTodayBlocks?: number;
    maxOverdueTasks?: number;
  }
): Promise<ConversationContext> {
  const now = new Date();
  const today = formatLocalDate(now);

  const {
    maxTodayTasks = 30,
    maxTodayEvents = 20,
    maxTodayBlocks = 30,
    maxOverdueTasks = 10,
  } = options || {};

  const database = db.getDb();

  // Gather all data in parallel
  const [
    todayTasksResult,
    todayEventsResult,
    todayBlocksResult,
    overdueTasksResult,
    workHoursStart,
    workHoursEnd,
    scheduleStyleVal,
    dreamInsights,
    pendingReminders,
    completedToday,
    totalPending,
    preferences,
  ] = await Promise.all([
    queryTodayTasks(database, today, maxTodayTasks),
    queryTodayEvents(database, today, maxTodayEvents),
    queryTodayBlocks(database, today, maxTodayBlocks),
    queryOverdueTasks(database, today, maxOverdueTasks),
    queryPreference(database, 'work_hours_start', '09:00'),
    queryPreference(database, 'work_hours_end', '18:00'),
    queryPreference(database, 'schedule_style', 'balanced'),
    loadDreamInsights(database),
    queryPendingReminders(database),
    queryCompletedToday(database, today),
    queryTotalPending(database),
    queryAllPreferences(database),
  ]);

  // Build truncation notes
  const truncationNotes: string[] = [];
  if (todayTasksResult.hiddenCount > 0) {
    truncationNotes.push(`今日任务: 还有 ${todayTasksResult.hiddenCount} 项未显示`);
  }
  if (todayEventsResult.hiddenCount > 0) {
    truncationNotes.push(`今日事件: 还有 ${todayEventsResult.hiddenCount} 项未显示`);
  }
  if (todayBlocksResult.hiddenCount > 0) {
    truncationNotes.push(`今日排程: 还有 ${todayBlocksResult.hiddenCount} 项未显示`);
  }
  if (overdueTasksResult.hiddenCount > 0) {
    truncationNotes.push(`逾期任务: 还有 ${overdueTasksResult.hiddenCount} 项未显示`);
  }

  return {
    currentDate: `${today}T${now.toTimeString().slice(0, 8)}`,
    todayTasks: todayTasksResult.items,
    todayEvents: todayEventsResult.items,
    todayBlocks: todayBlocksResult.items,
    overdueTasks: overdueTasksResult.items,
    workHours: {
      start: workHoursStart,
      end: workHoursEnd,
    },
    scheduleStyle: scheduleStyleVal,
    preferences,
    dreamInsights,
    pendingReminders,
    completedToday,
    totalPending,
    truncationNotes: truncationNotes.length > 0 ? truncationNotes : undefined,
  };
}

// Database Queries

async function queryTodayTasks(
  db: ReturnType<EvolveFlowDatabase['getDb']>,
  today: string,
  max: number
): Promise<QueryResult<ConversationContext['todayTasks'][0]>> {
  try {
    const countRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM tasks
         WHERE (date(created_at) = ? OR date(due_date) = ? OR status = 'pending' OR status = 'in_progress')
         AND status != 'cancelled'`
      )
      .get(today, today) as { cnt: number } | undefined;
    const total = countRow?.cnt || 0;

    const rows = db
      .prepare(
        `SELECT id, title, status, due_date, duration_minutes, project
         FROM tasks
         WHERE (date(created_at) = ? OR date(due_date) = ? OR status = 'pending' OR status = 'in_progress')
         AND status != 'cancelled'
         ORDER BY
           CASE WHEN due_date IS NULL THEN 1 ELSE 0 END,
           due_date ASC,
           sort_order ASC,
           created_at ASC
         LIMIT ?`
      )
      .all(today, today, max) as Array<Record<string, unknown>>;

    const items = rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      status: String(r.status),
      dueDate: r.due_date ? String(r.due_date) : undefined,
      estimatedMinutes: typeof r.duration_minutes === 'number' ? r.duration_minutes : undefined,
      project: r.project ? String(r.project) : undefined,
    }));

    return { items, hiddenCount: Math.max(0, total - max) };
  } catch {
    return { items: [], hiddenCount: 0 };
  }
}

async function queryTodayEvents(
  db: ReturnType<EvolveFlowDatabase['getDb']>,
  today: string,
  max: number
): Promise<QueryResult<ConversationContext['todayEvents'][0]>> {
  try {
    const countRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM events
         WHERE date(start_time) = ?`
      )
      .get(today) as { cnt: number } | undefined;
    const total = countRow?.cnt || 0;

    const rows = db
      .prepare(
        `SELECT id, title, start_time, end_time
         FROM events
         WHERE date(start_time) = ?
         ORDER BY start_time ASC
         LIMIT ?`
      )
      .all(today, max) as Array<Record<string, unknown>>;

    const items = rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      startTime: String(r.start_time),
      endTime: String(r.end_time),
    }));

    return { items, hiddenCount: Math.max(0, total - max) };
  } catch {
    return { items: [], hiddenCount: 0 };
  }
}

async function queryTodayBlocks(
  db: ReturnType<EvolveFlowDatabase['getDb']>,
  today: string,
  max: number
): Promise<QueryResult<ConversationContext['todayBlocks'][0]>> {
  try {
    const countRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM schedule_blocks sb
         LEFT JOIN tasks t ON sb.task_id = t.id
         WHERE sb.date = ?`
      )
      .get(today) as { cnt: number } | undefined;
    const total = countRow?.cnt || 0;

    const rows = db
      .prepare(
        `SELECT sb.id, sb.task_id, sb.start_time, sb.end_time, sb.locked,
                COALESCE(t.title, e.title, 'Untitled') as title
         FROM schedule_blocks sb
         LEFT JOIN tasks t ON sb.task_id = t.id
         LEFT JOIN events e ON sb.event_id = e.id
         WHERE sb.date = ?
         ORDER BY sb.start_time ASC
         LIMIT ?`
      )
      .all(today, max) as Array<Record<string, unknown>>;

    const items = rows.map((r) => ({
      id: String(r.id),
      taskId: r.task_id ? String(r.task_id) : undefined,
      title: String(r.title),
      startTime: String(r.start_time),
      endTime: String(r.end_time),
      isLocked: Boolean(r.locked),
    }));

    return { items, hiddenCount: Math.max(0, total - max) };
  } catch {
    return { items: [], hiddenCount: 0 };
  }
}

async function queryOverdueTasks(
  db: ReturnType<EvolveFlowDatabase['getDb']>,
  today: string,
  max: number
): Promise<QueryResult<ConversationContext['overdueTasks'][0]>> {
  try {
    const countRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM tasks
         WHERE date(due_date) < ?
         AND status IN ('pending', 'in_progress')`
      )
      .get(today) as { cnt: number } | undefined;
    const total = countRow?.cnt || 0;

    const rows = db
      .prepare(
        `SELECT id, title, due_date
         FROM tasks
         WHERE date(due_date) < ?
         AND status IN ('pending', 'in_progress')
         ORDER BY due_date ASC
         LIMIT ?`
      )
      .all(today, max) as Array<Record<string, unknown>>;

    const items = rows.map((r) => ({
      id: String(r.id),
      title: String(r.title),
      dueDate: r.due_date ? String(r.due_date) : undefined,
    }));

    return { items, hiddenCount: Math.max(0, total - max) };
  } catch {
    return { items: [], hiddenCount: 0 };
  }
}

async function queryPreference(
  db: ReturnType<EvolveFlowDatabase['getDb']>,
  key: string,
  defaultValue: string
): Promise<string> {
  try {
    const row = db.prepare('SELECT value FROM preferences WHERE key = ?').get(key) as
      | { value?: string }
      | undefined;
    return row?.value || defaultValue;
  } catch {
    return defaultValue;
  }
}

async function queryAllPreferences(
  db: ReturnType<EvolveFlowDatabase['getDb']>
): Promise<Record<string, string>> {
  try {
    const rows = db.prepare('SELECT key, value FROM preferences').all() as Array<{
      key: string;
      value: string;
    }>;
    const result: Record<string, string> = {};
    for (const row of rows) {
      result[row.key] = row.value;
    }
    return result;
  } catch {
    return {};
  }
}

async function queryPendingReminders(db: ReturnType<EvolveFlowDatabase['getDb']>): Promise<number> {
  try {
    const row = db
      .prepare("SELECT COUNT(*) as count FROM reminders WHERE status = 'pending'")
      .get() as { count?: number } | undefined;
    return row?.count || 0;
  } catch {
    return 0;
  }
}

async function queryCompletedToday(
  db: ReturnType<EvolveFlowDatabase['getDb']>,
  today: string
): Promise<number> {
  try {
    const row = db
      .prepare(
        `SELECT COUNT(*) as count FROM tasks
         WHERE status = 'completed'
         AND date(updated_at) = ?`
      )
      .get(today) as { count?: number } | undefined;
    return row?.count || 0;
  } catch {
    return 0;
  }
}

async function queryTotalPending(db: ReturnType<EvolveFlowDatabase['getDb']>): Promise<number> {
  try {
    const row = db
      .prepare("SELECT COUNT(*) as count FROM tasks WHERE status IN ('pending', 'in_progress')")
      .get() as { count?: number } | undefined;
    return row?.count || 0;
  } catch {
    return 0;
  }
}

// Dream Insights

async function loadDreamInsights(
  database: ReturnType<EvolveFlowDatabase['getDb']>
): Promise<string[]> {
  try {
    const rows = database
      .prepare(
        `SELECT insight_text FROM dream_insights WHERE confidence >= 0.5 ORDER BY created_at DESC LIMIT 10`
      )
      .all() as Array<{ insight_text: string }>;
    return rows.map((r) => r.insight_text);
  } catch {
    return [];
  }
}
