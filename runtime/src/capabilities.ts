export interface CapabilityDefinition {
  name: string;
  domain: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutating: boolean;
}

export const CAPABILITIES: CapabilityDefinition[] = [
  {
    name: 'task.create',
    domain: 'task',
    description: '创建新任务',
    inputSchema: {
      type: 'object',
      required: ['title'],
      properties: {
        title: { type: 'string' },
        duration_minutes: { type: 'number' },
        due_date: { type: 'string', format: 'date-time' },
        tags: { type: 'array', items: { type: 'string' } },
        project: { type: 'string' },
        time_effect_type: { type: 'string', enum: ['continuous', 'deadline', 'event_bound'] },
        parent_task_id: { type: 'string' },
      },
    },
    mutating: true,
  },
  {
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
        due_date: { type: 'string', format: 'date-time' },
        tags: { type: 'array', items: { type: 'string' } },
        project: { type: 'string' },
        time_effect_type: { type: 'string', enum: ['continuous', 'deadline', 'event_bound'] },
      },
    },
    mutating: true,
  },
  {
    name: 'task.complete',
    domain: 'task',
    description: '完成任务',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
      },
    },
    mutating: true,
  },
  {
    name: 'task.defer',
    domain: 'task',
    description: '延期任务',
    inputSchema: {
      type: 'object',
      required: ['task_id'],
      properties: {
        task_id: { type: 'string' },
        new_due_date: { type: 'string', format: 'date-time' },
      },
    },
    mutating: true,
  },
  {
    name: 'task.lock',
    domain: 'task',
    description: '锁定/解锁任务',
    inputSchema: {
      type: 'object',
      required: ['task_id', 'locked'],
      properties: {
        task_id: { type: 'string' },
        locked: { type: 'boolean' },
      },
    },
    mutating: true,
  },
  {
    name: 'event.create',
    domain: 'event',
    description: '创建新事件',
    inputSchema: {
      type: 'object',
      required: ['title', 'start_time', 'end_time'],
      properties: {
        title: { type: 'string' },
        start_time: { type: 'string', format: 'date-time' },
        end_time: { type: 'string', format: 'date-time' },
        description: { type: 'string' },
        recurrence_rule: { type: 'string' },
        reminder_minutes_before: { type: 'number' },
      },
    },
    mutating: true,
  },
  {
    name: 'event.update',
    domain: 'event',
    description: '更新事件',
    inputSchema: {
      type: 'object',
      required: ['event_id'],
      properties: {
        event_id: { type: 'string' },
        title: { type: 'string' },
        start_time: { type: 'string', format: 'date-time' },
        end_time: { type: 'string', format: 'date-time' },
        description: { type: 'string' },
      },
    },
    mutating: true,
  },
  {
    name: 'event.lock',
    domain: 'event',
    description: '锁定/解锁事件',
    inputSchema: {
      type: 'object',
      required: ['event_id', 'locked'],
      properties: {
        event_id: { type: 'string' },
        locked: { type: 'boolean' },
      },
    },
    mutating: true,
  },
  {
    name: 'schedule.plan_day',
    domain: 'schedule',
    description: '排程指定日期',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', format: 'date' },
      },
    },
    mutating: true,
  },
  {
    name: 'schedule.plan_range',
    domain: 'schedule',
    description: '排程日期范围',
    inputSchema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', format: 'date' },
        end_date: { type: 'string', format: 'date' },
      },
    },
    mutating: true,
  },
  {
    name: 'schedule.rebalance',
    domain: 'schedule',
    description: '重新平衡排程',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', format: 'date' },
      },
    },
    mutating: true,
  },
  {
    name: 'schedule.explain',
    domain: 'schedule',
    description: '解释排程原因',
    inputSchema: {
      type: 'object',
      properties: {
        schedule_block_id: { type: 'string' },
        date: { type: 'string', format: 'date' },
      },
    },
    mutating: false,
  },
  {
    name: 'reminder.snooze',
    domain: 'reminder',
    description: '稍后提醒',
    inputSchema: {
      type: 'object',
      required: ['reminder_id', 'duration_minutes'],
      properties: {
        reminder_id: { type: 'string' },
        duration_minutes: { type: 'number', enum: [5, 10, 30, 60] },
      },
    },
    mutating: true,
  },
  {
    name: 'summary.generate_daily',
    domain: 'summary',
    description: '生成每日总结',
    inputSchema: {
      type: 'object',
      properties: {
        date: { type: 'string', format: 'date' },
      },
    },
    mutating: true,
  },
  {
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
  },
  {
    name: 'undo.revert_action',
    domain: 'undo',
    description: '撤回动作',
    inputSchema: {
      type: 'object',
      required: ['action_log_id'],
      properties: {
        action_log_id: { type: 'string' },
      },
    },
    mutating: true,
  },
  {
    name: 'memory.clear_ai_history',
    domain: 'memory',
    description: '清除 AI 对话历史',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    mutating: true,
  },
  {
    name: 'memory.clear_learned_state',
    domain: 'memory',
    description: '清除学习结果与记忆',
    inputSchema: {
      type: 'object',
      properties: {
        include_dream: { type: 'boolean' },
      },
    },
    mutating: true,
  },
];

export const CAPABILITY_NAMES = new Set(CAPABILITIES.map((c) => c.name));

export function getCapability(name: string): CapabilityDefinition | undefined {
  return CAPABILITIES.find((c) => c.name === name);
}

export function isMutatingCapability(name: string): boolean {
  const cap = getCapability(name);
  return cap?.mutating ?? false;
}
