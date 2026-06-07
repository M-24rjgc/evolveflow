import type Database from 'better-sqlite3';
import type { CapabilityDefinition, CapabilityContext, CapabilityResult } from './types.js';
import { CapabilityRegistry } from './registry.js';
import {
  TaskService,
  EventService,
  ScheduleService,
  ReminderService,
  ActionLogService,
  UndoService,
  SummaryService,
  PreferenceService,
  MemoryProjectionService,
} from '@evolveflow/domain';
import type { TaskStatus } from '@evolveflow/domain';
import { EvolveFlowDatabase, BackupService } from '@evolveflow/storage';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

const TASK_STATUSES: ReadonlySet<string> = new Set([
  'pending',
  'in_progress',
  'completed',
  'deferred',
  'cancelled',
]);
const SENSITIVE_PREFERENCE_KEYS: ReadonlySet<string> = new Set(['api_key']);

const isSensitivePreferenceSet = (name: string, input: Record<string, unknown>): boolean =>
  name === 'preference.set' &&
  typeof input.key === 'string' &&
  SENSITIVE_PREFERENCE_KEYS.has(input.key);

const localDateString = (date: Date = new Date()): string => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

export function createRegistry(db: EvolveFlowDatabase, dataDir?: string): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  const database = db.getDb();

  const taskService = new TaskService(database);
  const eventService = new EventService(database);
  const reminderService = new ReminderService(database);
  const actionLogService = new ActionLogService(database);
  const undoService = new UndoService(database, actionLogService);
  const summaryService = new SummaryService(database, taskService);
  const preferenceService = new PreferenceService(database);
  const scheduleService = new ScheduleService(
    database,
    taskService,
    eventService,
    preferenceService
  );
  const memoryProjectionService = new MemoryProjectionService(database, preferenceService);

  const backupService = dataDir ? new BackupService(db, dataDir) : undefined;
  const backupOutputDir = dataDir ? path.join(dataDir, 'backups') : undefined;
  const workspaceRoot = path.resolve(process.env.EVOLVEFLOW_WORKSPACE_ROOT || process.cwd());

  const resolveWorkspacePath = (inputPath: unknown): string => {
    if (typeof inputPath !== 'string' || !inputPath.trim()) {
      throw new Error('path is required');
    }
    const rawPath = inputPath.trim();
    const resolved = path.resolve(workspaceRoot, rawPath);
    if (!resolved.startsWith(workspaceRoot)) {
      throw new Error('Path must stay inside the workspace');
    }
    return resolved;
  };

  const getScheduleSnapshot = (date: string): Record<string, unknown> => ({
    date,
    blocks: JSON.stringify(scheduleService.getDaySchedule(date)),
  });

  const getScheduleRangeSnapshot = (
    startDate: string,
    endDate: string
  ): Record<string, unknown> => {
    const dates: string[] = [];
    const blocksByDate: Record<string, string> = {};
    const start = new Date(startDate);
    const end = new Date(endDate);

    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) {
      return getScheduleSnapshot(localDateString());
    }

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const date = d.toISOString().split('T')[0];
      dates.push(date);
      blocksByDate[date] = JSON.stringify(scheduleService.getDaySchedule(date));
    }

    return { dates, blocksByDate };
  };

  const getStateBefore = (
    name: string,
    input: Record<string, unknown>
  ): Record<string, unknown> | undefined => {
    try {
      if (name.startsWith('task.') && name !== 'task.create') {
        const taskId = input.task_id as string | undefined;
        const task = taskId ? taskService.getById(taskId) : null;
        return task ? { ...task } : undefined;
      }
      if (name.startsWith('event.') && name !== 'event.create') {
        const eventId = input.event_id as string | undefined;
        const event = eventId ? eventService.getById(eventId) : null;
        return event ? { ...event } : undefined;
      }
      if (
        name === 'schedule.plan_day' ||
        name === 'schedule.rebalance' ||
        name === 'schedule.clear_day'
      ) {
        const date = (input.date as string | undefined) ?? localDateString();
        return getScheduleSnapshot(date);
      }
      if (name === 'schedule.plan_range') {
        const startDate = input.start_date as string | undefined;
        const endDate = input.end_date as string | undefined;
        if (!startDate || !endDate) {
          return undefined;
        }
        return getScheduleRangeSnapshot(startDate, endDate);
      }
      if (name.startsWith('reminder.')) {
        const reminderId = input.reminder_id as string | undefined;
        if (reminderId) {
          const row = database.prepare('SELECT * FROM reminders WHERE id = ?').get(reminderId) as
            | Record<string, unknown>
            | undefined;
          return row ? { ...row } : undefined;
        }
      }
      if (name.startsWith('preference.')) {
        const key = input.key as string | undefined;
        if (key) {
          if (SENSITIVE_PREFERENCE_KEYS.has(key)) {
            return undefined;
          }
          const value = preferenceService.get(key);
          return { key, value: value ?? '' };
        }
      }
    } catch (snapshotErr) {
      console.error(`Failed to snapshot state before ${name}:`, snapshotErr);
    }
    return undefined;
  };

  const getStateAfter = (result: CapabilityResult): Record<string, unknown> | undefined => {
    if (!result.data || typeof result.data !== 'object') {
      return undefined;
    }
    if (Array.isArray(result.data)) {
      return { items: result.data };
    }
    return result.data as Record<string, unknown>;
  };

  const wrapMutating = (
    name: string,
    handler: (
      input: Record<string, unknown>,
      context: CapabilityContext
    ) => Promise<CapabilityResult>
  ) => {
    return async (
      input: Record<string, unknown>,
      context: CapabilityContext
    ): Promise<CapabilityResult> => {
      const stateBefore = getStateBefore(name, input);
      const result = await handler(input, context);
      if (result.success) {
        const revision = db.incrementRevision();
        result.revision = revision;
        if (isSensitivePreferenceSet(name, input)) {
          return result;
        }
        try {
          const actionLog = actionLogService.record({
            capability: name,
            actor: context.actor,
            origin: context.origin,
            idempotencyKey: context.idempotency_key,
            inputSnapshot: input,
            stateBefore,
            stateAfter: getStateAfter(result),
          });
          result.action_log_id = actionLog.id;
        } catch (logErr) {
          console.error(`Failed to record action log for ${name}:`, logErr);
        }
      }
      return result;
    };
  };

  registry.register({
    name: 'task.create',
    domain: 'task',
    description: '创建新任务',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        duration_minutes: { type: 'number' },
        due_date: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        project: { type: 'string' },
        time_effect_type: { type: 'string' },
        parent_task_id: { type: 'string' },
      },
    },
    mutating: true,
    handler: wrapMutating('task.create', async (input) => {
      const task = taskService.create({
        title: input.title as string,
        description: input.description as string | undefined,
        duration_minutes: input.duration_minutes as number | undefined,
        due_date: input.due_date as string | undefined,
        time_effect_type: input.time_effect_type as
          | 'continuous'
          | 'deadline'
          | 'event_bound'
          | undefined,
        parent_task_id: input.parent_task_id as string | undefined,
        project: input.project as string | undefined,
        tags: input.tags as string[] | undefined,
      });
      return { success: true, data: task };
    }),
  });

  registry.register({
    name: 'task.update',
    domain: 'task',
    description: '更新任务',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        title: { type: 'string' },
        duration_minutes: { type: 'number' },
        due_date: { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        project: { type: 'string' },
        time_effect_type: { type: 'string' },
      },
    },
    mutating: true,
    handler: wrapMutating('task.update', async (input) => {
      try {
        const task = taskService.update({
          task_id: input.task_id as string,
          title: input.title as string | undefined,
          description: input.description as string | undefined,
          duration_minutes: input.duration_minutes as number | undefined,
          due_date: input.due_date as string | undefined,
          time_effect_type: input.time_effect_type as
            | 'continuous'
            | 'deadline'
            | 'event_bound'
            | undefined,
          project: input.project as string | undefined,
          tags: input.tags as string[] | undefined,
        });
        return { success: true, data: task };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }),
  });

  registry.register({
    name: 'task.complete',
    domain: 'task',
    description: '完成任务',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    },
    mutating: true,
    handler: wrapMutating('task.complete', async (input) => {
      try {
        const task = taskService.complete(input.task_id as string);
        return { success: true, data: task };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }),
  });

  registry.register({
    name: 'task.defer',
    domain: 'task',
    description: '延期任务',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' }, new_due_date: { type: 'string' } },
    },
    mutating: true,
    handler: wrapMutating('task.defer', async (input) => {
      try {
        const task = taskService.defer(
          input.task_id as string,
          input.new_due_date as string | undefined
        );
        return { success: true, data: task };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }),
  });

  registry.register({
    name: 'task.lock',
    domain: 'task',
    description: '锁定/解锁任务',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'locked'],
      properties: { task_id: { type: 'string' }, locked: { type: 'boolean' } },
    },
    mutating: true,
    handler: wrapMutating('task.lock', async (input) => {
      const task = taskService.lock(input.task_id as string, input.locked as boolean);
      return { success: true, data: task };
    }),
  });

  registry.register({
    name: 'task.delete',
    domain: 'task',
    description: '删除任务',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    },
    mutating: true,
    handler: wrapMutating('task.delete', async (input) => {
      try {
        taskService.delete(input.task_id as string);
        return { success: true };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }),
  });

  registry.register({
    name: 'task.cancel',
    domain: 'task',
    description: '取消任务',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: { task_id: { type: 'string' } },
    },
    mutating: true,
    handler: wrapMutating('task.cancel', async (input) => {
      try {
        const task = taskService.cancel(input.task_id as string);
        return { success: true, data: task };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }),
  });

  registry.register({
    name: 'event.create',
    domain: 'event',
    description: '创建新事件',
    inputSchema: {
      type: 'object',
      required: ['title', 'start_time', 'end_time'],
      properties: {
        title: { type: 'string' },
        start_time: { type: 'string' },
        end_time: { type: 'string' },
        description: { type: 'string' },
        bound_task_id: { type: 'string' },
      },
    },
    mutating: true,
    handler: wrapMutating('event.create', async (input) => {
      const event = eventService.create({
        title: input.title as string,
        start_time: input.start_time as string,
        end_time: input.end_time as string,
        description: input.description as string | undefined,
        bound_task_id: input.bound_task_id as string | undefined,
      });
      return { success: true, data: event };
    }),
  });

  registry.register({
    name: 'event.update',
    domain: 'event',
    description: '更新事件',
    inputSchema: {
      type: 'object',
      required: ['event_id'],
      properties: {
        event_id: { type: 'string' },
        title: { type: 'string' },
        start_time: { type: 'string' },
        end_time: { type: 'string' },
        description: { type: 'string' },
      },
    },
    mutating: true,
    handler: wrapMutating('event.update', async (input) => {
      try {
        const event = eventService.update({
          event_id: input.event_id as string,
          title: input.title as string | undefined,
          start_time: input.start_time as string | undefined,
          end_time: input.end_time as string | undefined,
          description: input.description as string | undefined,
        });
        return { success: true, data: event };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }),
  });

  registry.register({
    name: 'event.lock',
    domain: 'event',
    description: '锁定/解锁事件',
    inputSchema: {
      type: 'object',
      required: ['event_id', 'locked'],
      properties: { event_id: { type: 'string' }, locked: { type: 'boolean' } },
    },
    mutating: true,
    handler: wrapMutating('event.lock', async (input) => {
      const event = eventService.lock(input.event_id as string, input.locked as boolean);
      return { success: true, data: event };
    }),
  });

  registry.register({
    name: 'event.delete',
    domain: 'event',
    description: '删除事件',
    inputSchema: {
      type: 'object',
      required: ['event_id'],
      properties: { event_id: { type: 'string' } },
    },
    mutating: true,
    handler: wrapMutating('event.delete', async (input) => {
      try {
        eventService.delete(input.event_id as string);
        return { success: true };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }),
  });

  registry.register({
    name: 'schedule.plan_day',
    domain: 'schedule',
    description: '排程指定日期 (优化加权评分算法)',
    inputSchema: { type: 'object', properties: { date: { type: 'string' } } },
    mutating: true,
    handler: wrapMutating('schedule.plan_day', async (input) => {
      const date = (input.date as string) ?? localDateString();
      const blocks = scheduleService.planDay(date);
      return { success: true, data: blocks };
    }),
  });

  registry.register({
    name: 'schedule.plan_range',
    domain: 'schedule',
    description: '排程日期范围',
    inputSchema: {
      type: 'object',
      properties: { start_date: { type: 'string' }, end_date: { type: 'string' } },
    },
    mutating: true,
    handler: wrapMutating('schedule.plan_range', async (input) => {
      const blocks = scheduleService.planRange(
        input.start_date as string,
        input.end_date as string
      );
      return { success: true, data: blocks };
    }),
  });

  registry.register({
    name: 'schedule.rebalance',
    domain: 'schedule',
    description: '重新平衡排程',
    inputSchema: { type: 'object', properties: { date: { type: 'string' } } },
    mutating: true,
    handler: wrapMutating('schedule.rebalance', async (input) => {
      const date = (input.date as string) ?? localDateString();
      const blocks = scheduleService.rebalance(date);
      return { success: true, data: blocks };
    }),
  });

  registry.register({
    name: 'schedule.clear_day',
    domain: 'schedule',
    description:
      'Clear generated schedule blocks for a date while keeping locked and manually adjusted blocks',
    inputSchema: { type: 'object', properties: { date: { type: 'string' } } },
    mutating: true,
    handler: wrapMutating('schedule.clear_day', async (input) => {
      const date = (input.date as string) ?? localDateString();
      const result = scheduleService.clearGeneratedSchedule(date);
      return { success: true, data: result };
    }),
  });

  registry.register({
    name: 'schedule.get_blocks',
    domain: 'schedule',
    description: '获取指定日期的排程块（只读，不触发排程）',
    inputSchema: { type: 'object', properties: { date: { type: 'string' } } },
    mutating: false,
    handler: async (input) => {
      const date = (input.date as string) ?? localDateString();
      const blocks = scheduleService.getDaySchedule(date);
      return { success: true, data: blocks };
    },
  });

  registry.register({
    name: 'schedule.explain',
    domain: 'schedule',
    description: '解释排程原因',
    inputSchema: {
      type: 'object',
      properties: { schedule_block_id: { type: 'string' }, date: { type: 'string' } },
    },
    mutating: false,
    handler: async (input) => {
      const explanation = scheduleService.explain(input.schedule_block_id as string);
      return { success: true, data: explanation };
    },
  });

  registry.register({
    name: 'schedule.analyze_quality',
    domain: 'schedule',
    description: '分析排程质量',
    inputSchema: { type: 'object', properties: { date: { type: 'string' } } },
    mutating: false,
    handler: async (input) => {
      const date = (input.date as string) ?? localDateString();
      const metrics = scheduleService.analyzeScheduleQuality(date);
      return { success: true, data: metrics };
    },
  });

  registry.register({
    name: 'reminder.snooze',
    domain: 'reminder',
    description: '稍后提醒',
    inputSchema: {
      type: 'object',
      required: ['reminder_id', 'duration_minutes'],
      properties: { reminder_id: { type: 'string' }, duration_minutes: { type: 'number' } },
    },
    mutating: true,
    handler: wrapMutating('reminder.snooze', async (input) => {
      try {
        const reminder = reminderService.snooze(
          input.reminder_id as string,
          input.duration_minutes as number
        );
        return { success: true, data: reminder };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }),
  });

  registry.register({
    name: 'summary.generate_daily',
    domain: 'summary',
    description: '生成每日总结',
    inputSchema: { type: 'object', properties: { date: { type: 'string' } } },
    mutating: true,
    handler: wrapMutating('summary.generate_daily', async (input) => {
      const date = (input.date as string) ?? localDateString();
      const summary = summaryService.generateDaily(date);
      return { success: true, data: summary };
    }),
  });

  registry.register({
    name: 'history.list_actions',
    domain: 'history',
    description: '列出动作记录',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
        offset: { type: 'number' },
        actor: { type: 'string' },
        origin: { type: 'string' },
      },
    },
    mutating: false,
    handler: async (input) => {
      const logs = actionLogService.list({
        limit: input.limit as number | undefined,
        offset: input.offset as number | undefined,
        actor: input.actor as 'user' | 'ai' | 'cli' | 'system' | undefined,
        origin: input.origin as 'gui' | 'ai_page' | 'cli' | 'dream' | 'reminder_system' | undefined,
      });
      return { success: true, data: logs };
    },
  });

  registry.register({
    name: 'undo.revert_action',
    domain: 'undo',
    description: '撤回动作',
    inputSchema: {
      type: 'object',
      required: ['action_log_id'],
      properties: { action_log_id: { type: 'string' } },
    },
    mutating: true,
    handler: wrapMutating('undo.revert_action', async (input) => {
      try {
        undoService.revertAction(input.action_log_id as string);
        return { success: true };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }),
  });

  registry.register({
    name: 'memory.clear_ai_history',
    domain: 'memory',
    description: '清除 AI 对话历史',
    inputSchema: { type: 'object', properties: {} },
    mutating: true,
    handler: wrapMutating('memory.clear_ai_history', async () => {
      database.prepare('DELETE FROM ai_messages').run();
      database.prepare('DELETE FROM ai_sessions').run();
      return { success: true };
    }),
  });

  registry.register({
    name: 'memory.clear_learned_state',
    domain: 'memory',
    description: '清除学习结果与记忆',
    inputSchema: { type: 'object', properties: { include_dream: { type: 'boolean' } } },
    mutating: true,
    handler: wrapMutating('memory.clear_learned_state', async (input) => {
      const includeDream = (input.include_dream as boolean) ?? true;
      if (includeDream) {
        memoryProjectionService.clearDreamProjections();
      }
      memoryProjectionService.clearAllLearnedState(!includeDream);
      return { success: true };
    }),
  });

  registry.register({
    name: 'task.list',
    domain: 'task',
    description: '列出任务',
    inputSchema: {
      type: 'object',
      properties: { status: { type: 'string' }, project: { type: 'string' } },
    },
    mutating: false,
    handler: async (input) => {
      const filters: { status?: TaskStatus; project?: string } = {};
      if (typeof input.status === 'string' && TASK_STATUSES.has(input.status)) {
        filters.status = input.status as TaskStatus;
      }
      if (input.project) {
        filters.project = input.project as string;
      }
      const tasks = taskService.list(filters);
      return { success: true, data: tasks };
    },
  });

  registry.register({
    name: 'event.list',
    domain: 'event',
    description: '列出事件',
    inputSchema: {
      type: 'object',
      properties: { start: { type: 'string' }, end: { type: 'string' } },
    },
    mutating: false,
    handler: async (input) => {
      const events = eventService.list(
        input.start && input.end
          ? { start: input.start as string, end: input.end as string }
          : undefined
      );
      return { success: true, data: events };
    },
  });

  registry.register({
    name: 'event.find_conflicts',
    domain: 'event',
    description: '查找时间冲突',
    inputSchema: {
      type: 'object',
      required: ['start_time', 'end_time'],
      properties: {
        start_time: { type: 'string' },
        end_time: { type: 'string' },
        exclude_event_id: { type: 'string' },
      },
    },
    mutating: false,
    handler: async (input) => {
      const events = eventService.findConflicts(
        input.start_time as string,
        input.end_time as string,
        input.exclude_event_id as string | undefined
      );
      return { success: true, data: events };
    },
  });

  registry.register({
    name: 'file.list',
    domain: 'file',
    description: '列出工作区内目录文件',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    mutating: false,
    handler: async (input) => {
      try {
        const dirPath = resolveWorkspacePath((input.path as string | undefined) || '.');
        const limit = Math.min(Math.max(Number(input.limit || 50), 1), 200);
        const entries = fs
          .readdirSync(dirPath, { withFileTypes: true })
          .slice(0, limit)
          .map((entry) => ({
            name: entry.name,
            path: path.relative(workspaceRoot, path.join(dirPath, entry.name)),
            type: entry.isDirectory() ? 'directory' : 'file',
          }));
        return { success: true, data: entries };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
  });

  registry.register({
    name: 'file.read',
    domain: 'file',
    description: '读取工作区内文本文件',
    inputSchema: {
      type: 'object',
      required: ['path'],
      properties: {
        path: { type: 'string' },
        max_bytes: { type: 'number' },
      },
    },
    mutating: false,
    handler: async (input) => {
      try {
        const filePath = resolveWorkspacePath(input.path);
        const maxBytes = Math.min(Math.max(Number(input.max_bytes || 20000), 1), 200000);
        const buffer = fs.readFileSync(filePath);
        return {
          success: true,
          data: {
            path: path.relative(workspaceRoot, filePath),
            truncated: buffer.length > maxBytes,
            content: buffer.subarray(0, maxBytes).toString('utf8'),
          },
        };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
  });

  registry.register({
    name: 'file.search',
    domain: 'file',
    description: '在工作区内搜索文本',
    inputSchema: {
      type: 'object',
      required: ['query'],
      properties: {
        query: { type: 'string' },
        path: { type: 'string' },
        limit: { type: 'number' },
      },
    },
    mutating: false,
    handler: async (input) => {
      try {
        const query = String(input.query || '');
        if (!query) {
          return { success: false, error: 'query is required' };
        }
        const root = resolveWorkspacePath((input.path as string | undefined) || '.');
        const limit = Math.min(Math.max(Number(input.limit || 50), 1), 200);
        const results: Array<{ path: string; line: number; text: string }> = [];

        const walk = (dir: string) => {
          if (results.length >= limit) {
            return;
          }
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (results.length >= limit) {
              return;
            }
            if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') {
              continue;
            }
            const entryPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              walk(entryPath);
              continue;
            }
            if (!entry.isFile()) {
              continue;
            }
            let text = '';
            try {
              const stat = fs.statSync(entryPath);
              if (stat.size > 500_000) {
                continue;
              }
              text = fs.readFileSync(entryPath, 'utf8');
            } catch {
              continue;
            }
            const lines = text.split(/\r?\n/);
            for (let i = 0; i < lines.length && results.length < limit; i++) {
              if (lines[i].includes(query)) {
                results.push({
                  path: path.relative(workspaceRoot, entryPath),
                  line: i + 1,
                  text: lines[i].slice(0, 240),
                });
              }
            }
          }
        };

        walk(root);
        return { success: true, data: results };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
  });

  registry.register({
    name: 'file.write',
    domain: 'file',
    description: '写入工作区内文本文件',
    inputSchema: {
      type: 'object',
      required: ['path', 'content'],
      properties: {
        path: { type: 'string' },
        content: { type: 'string' },
        overwrite: { type: 'boolean' },
      },
    },
    mutating: true,
    handler: wrapMutating('file.write', async (input) => {
      try {
        const filePath = resolveWorkspacePath(input.path);
        const overwrite = input.overwrite !== false;
        if (!overwrite && fs.existsSync(filePath)) {
          return { success: false, error: 'File already exists' };
        }
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, String(input.content ?? ''), 'utf8');
        return { success: true, data: { path: path.relative(workspaceRoot, filePath) } };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }),
  });

  registry.register({
    name: 'terminal.run',
    domain: 'terminal',
    description: '在工作区内运行终端命令',
    inputSchema: {
      type: 'object',
      required: ['command'],
      properties: {
        command: { type: 'string' },
        timeout_ms: { type: 'number' },
      },
    },
    mutating: true,
    handler: wrapMutating('terminal.run', async (input) => {
      const command = String(input.command || '');
      if (!command) {
        return { success: false, error: 'command is required' };
      }
      const timeout = Math.min(Math.max(Number(input.timeout_ms || 10000), 1000), 60000);
      return new Promise<CapabilityResult>((resolve) => {
        exec(command, { cwd: workspaceRoot, timeout }, (error, stdout, stderr) => {
          resolve({
            success: !error,
            error: error ? error.message : undefined,
            data: {
              stdout: stdout.slice(0, 20000),
              stderr: stderr.slice(0, 20000),
            },
          });
        });
      });
    }),
  });

  registry.register({
    name: 'preference.set',
    domain: 'preference',
    description: '设置偏好',
    inputSchema: {
      type: 'object',
      required: ['key', 'value'],
      properties: { key: { type: 'string' }, value: { type: 'string' } },
    },
    mutating: true,
    handler: wrapMutating('preference.set', async (input) => {
      preferenceService.set(input.key as string, input.value as string);
      return { success: true };
    }),
  });

  registry.register({
    name: 'preference.get',
    domain: 'preference',
    description: '获取偏好',
    inputSchema: {
      type: 'object',
      required: ['key'],
      properties: { key: { type: 'string' } },
    },
    mutating: false,
    handler: async (input) => {
      const value = preferenceService.get(input.key as string);
      return { success: true, data: value };
    },
  });

  registry.register({
    name: 'dream.get_insights',
    domain: 'dream',
    description: '获取 Dream 系统洞察分析结果',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number' },
      },
    },
    mutating: false,
    handler: async (input) => {
      const limit = (input.limit as number) ?? 20;
      const rows = database
        .prepare(
          `SELECT id, category, insight_text, confidence, supporting_data, created_at
           FROM dream_insights
           ORDER BY created_at DESC
           LIMIT ?`
        )
        .all(limit);
      return { success: true, data: rows };
    },
  });

  registry.register({
    name: 'api_key.status',
    domain: 'preference',
    description: '检查 API Key 配置状态（不返回完整密钥）',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    handler: async () => {
      const value = preferenceService.get('api_key');
      const configured = !!value;
      const prefix = value ? value.slice(0, 4) : '';
      return { success: true, data: { configured, prefix } };
    },
  });

  // ── AI capability stubs (handled by sidecar runtime) ──────────
  registry.register({
    name: 'ai.check_connectivity',
    domain: 'ai',
    description: '检查 AI 连接状态',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    handler: async () => ({
      success: true,
      data: { connected: false, reason: 'Handled by runtime' },
    }),
  });

  registry.register({
    name: 'ai.stream',
    domain: 'ai',
    description: '流式 AI 对话（实际由 sidecar 处理）',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' }, session_id: { type: 'string' } },
    },
    mutating: false,
    handler: async () => ({ success: true, data: { streaming: true } }),
  });

  registry.register({
    name: 'ai.chat',
    domain: 'ai',
    description: 'AI 对话（非流式）',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' }, session_id: { type: 'string' } },
    },
    mutating: false,
    handler: async () => ({ success: true, data: { text: 'Handled by AI engine' } }),
  });

  registry.register({
    name: 'ai.cancel_stream',
    domain: 'ai',
    description: '取消正在进行的 AI 流式响应',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } } },
    mutating: false,
    handler: async () => ({ success: true, data: { cancelled: true } }),
  });

  registry.register({
    name: 'ai.get_context',
    domain: 'ai',
    description: '获取 AI 对话上下文',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    handler: async () => ({ success: true, data: { message: 'Handled by runtime' } }),
  });

  registry.register({
    name: 'ai.delete_session',
    domain: 'ai',
    description: '删除 AI 对话会话',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' } } },
    mutating: false,
    handler: async () => ({ success: true, data: { deleted: true } }),
  });

  // ── Dream capability stubs (handled by sidecar runtime) ──────
  registry.register({
    name: 'dream.run',
    domain: 'dream',
    description: '运行 Dream 分析引擎',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    handler: async () => ({ success: true, data: { status: 'completed', insights: [] } }),
  });

  registry.register({
    name: 'dream.status',
    domain: 'dream',
    description: '获取 Dream 引擎运行状态',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    handler: async () => ({ success: true, data: { running: false, lastRun: null } }),
  });

  // ── Buddy capability stubs (handled by sidecar runtime) ──────
  registry.register({
    name: 'buddy.greet',
    domain: 'buddy',
    description: '获取 Buddy 问候语和当前状态',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    handler: async () => ({
      success: true,
      data: { greeting: '你好！', mood: 'neutral', level: 'full' },
    }),
  });

  registry.register({
    name: 'buddy.comment',
    domain: 'buddy',
    description: '获取 Buddy 对当前日程安排的评论',
    inputSchema: { type: 'object', properties: { taskCount: { type: 'number' } } },
    mutating: false,
    handler: async (input) => {
      const taskCount = (input.taskCount as number) || 0;
      return { success: true, data: { comment: `今天有 ${taskCount} 项安排。`, mood: 'neutral' } };
    },
  });

  // ── Reminder.list (real implementation) ─────────────────────
  registry.register({
    name: 'reminder.list',
    domain: 'reminder',
    description: '列出所有提醒',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    handler: async () => {
      const rows = database
        .prepare('SELECT * FROM reminders ORDER BY created_at DESC')
        .all() as Record<string, unknown>[];
      const reminders = rows.map((r) => ({
        id: r.id as string,
        task_id: r.task_id as string | null,
        event_id: r.event_id as string | null,
        trigger_at: r.trigger_at as string,
        snoozed_until: r.snoozed_until as string | null,
        status: r.status as string,
        message: r.message as string | null,
        created_at: r.created_at as string,
      }));
      return { success: true, data: reminders };
    },
  });

  // ── Backup capabilities (real implementations) ────────────
  registry.register({
    name: 'backup.list',
    domain: 'backup',
    description: '列出所有可用备份',
    inputSchema: { type: 'object', properties: {} },
    mutating: false,
    handler: async () => {
      if (!backupOutputDir || !fs.existsSync(backupOutputDir)) {
        return { success: true, data: { backups: [], total_count: 0, total_size_bytes: 0 } };
      }
      const entries = fs.readdirSync(backupOutputDir, { withFileTypes: true });
      const backupDirs = entries
        .filter((e) => e.isDirectory() && e.name.startsWith('evolveflow-backup-'))
        .map((e) => {
          const fullPath = path.join(backupOutputDir, e.name);
          const dbPath = path.join(fullPath, 'evolveflow.db');
          const sizeBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
          const date = e.name
            .replace('evolveflow-backup-', '')
            .replace(/-/g, ':')
            .replace(/T/g, ' ');
          return {
            path: fullPath,
            name: e.name,
            date,
            size_bytes: sizeBytes,
          };
        });
      backupDirs.sort((a, b) => b.date.localeCompare(a.date));
      const totalCount = backupDirs.length;
      const totalSizeBytes = backupDirs.reduce((sum, b) => sum + b.size_bytes, 0);
      return {
        success: true,
        data: { backups: backupDirs, total_count: totalCount, total_size_bytes: totalSizeBytes },
      };
    },
  });

  registry.register({
    name: 'backup.create',
    domain: 'backup',
    description: '创建新备份',
    inputSchema: { type: 'object', properties: {} },
    mutating: true,
    handler: wrapMutating('backup.create', async () => {
      if (!backupService || !backupOutputDir) {
        return { success: false, error: 'Backup service not available (dataDir not configured)' };
      }
      try {
        const backupDir = backupService.backupTo(backupOutputDir);
        const name = path.basename(backupDir);
        return { success: true, data: { path: backupDir, name } };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }),
  });

  registry.register({
    name: 'backup.verify',
    domain: 'backup',
    description: '验证备份完整性',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    mutating: false,
    handler: async (input) => {
      if (!backupService) {
        return { success: false, error: 'Backup service not available' };
      }
      try {
        const valid = backupService.verifyBackup(input.path as string);
        return {
          success: true,
          data: { valid, error: valid ? undefined : 'Backup verification failed' },
        };
      } catch (e) {
        return { success: true, data: { valid: false, error: (e as Error).message } };
      }
    },
  });

  registry.register({
    name: 'backup.restore',
    domain: 'backup',
    description: '从备份恢复数据',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    mutating: true,
    handler: async (input) => {
      if (!backupService) {
        return { success: false, error: 'Backup service not available' };
      }
      try {
        backupService.restoreFrom(input.path as string);
        return { success: true };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
  });

  registry.register({
    name: 'backup.delete',
    domain: 'backup',
    description: '删除指定备份',
    inputSchema: { type: 'object', required: ['path'], properties: { path: { type: 'string' } } },
    mutating: true,
    handler: wrapMutating('backup.delete', async (input) => {
      const backupPath = input.path as string;
      if (!backupPath || !fs.existsSync(backupPath)) {
        return { success: false, error: 'Backup path not found' };
      }
      try {
        fs.rmSync(backupPath, { recursive: true });
        return { success: true };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    }),
  });

  return registry;
}
