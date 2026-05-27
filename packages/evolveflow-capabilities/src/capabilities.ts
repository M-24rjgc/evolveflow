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
import { EvolveFlowDatabase } from '@evolveflow/storage';

export function createRegistry(db: EvolveFlowDatabase): CapabilityRegistry {
  const registry = new CapabilityRegistry();
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

  const wrapMutating = (
    name: string,
    handler: (input: Record<string, unknown>, context: CapabilityContext) => Promise<CapabilityResult>,
  ) => {
    return async (input: Record<string, unknown>, context: CapabilityContext): Promise<CapabilityResult> => {
      const result = await handler(input, context);
      if (result.success) {
        db.incrementRevision();
        try {
          actionLogService.record({
            capability: name,
            actor: context.actor,
            origin: context.origin,
            idempotency_key: context.idempotency_key,
            input_snapshot: JSON.stringify(input),
          });
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
        time_effect_type: input.time_effect_type as 'continuous' | 'deadline' | 'event_bound' | undefined,
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
          time_effect_type: input.time_effect_type as 'continuous' | 'deadline' | 'event_bound' | undefined,
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
    inputSchema: { type: 'object', required: ['task_id'], properties: { task_id: { type: 'string' } } },
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
        const task = taskService.defer(input.task_id as string, input.new_due_date as string | undefined);
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
    name: 'schedule.plan_day',
    domain: 'schedule',
    description: '排程指定日期',
    inputSchema: { type: 'object', properties: { date: { type: 'string' } } },
    mutating: true,
    handler: wrapMutating('schedule.plan_day', async (input) => {
      const date = (input.date as string) ?? new Date().toISOString().split('T')[0];
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
      const blocks = scheduleService.planRange(input.start_date as string, input.end_date as string);
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
      const date = (input.date as string) ?? new Date().toISOString().split('T')[0];
      const blocks = scheduleService.rebalance(date);
      return { success: true, data: blocks };
    }),
  });

  registry.register({
    name: 'schedule.explain',
    domain: 'schedule',
    description: '解释排程原因',
    inputSchema: { type: 'object', properties: { schedule_block_id: { type: 'string' }, date: { type: 'string' } } },
    mutating: false,
    handler: async (input) => {
      const explanation = scheduleService.explain(input.schedule_block_id as string);
      return { success: true, data: explanation };
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
        const reminder = reminderService.snooze(input.reminder_id as string, input.duration_minutes as number);
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
      const date = (input.date as string) ?? new Date().toISOString().split('T')[0];
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
      properties: { limit: { type: 'number' }, offset: { type: 'number' }, actor: { type: 'string' }, origin: { type: 'string' } },
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
    inputSchema: { type: 'object', required: ['action_log_id'], properties: { action_log_id: { type: 'string' } } },
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
      memoryProjectionService.clearAllLearnedState();
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
      const filters: { status?: string; project?: string } = {};
      if (input.status) filters.status = input.status as string;
      if (input.project) filters.project = input.project as string;
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
        input.start && input.end ? { start: input.start as string, end: input.end as string } : undefined,
      );
      return { success: true, data: events };
    },
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

  return registry;
}
