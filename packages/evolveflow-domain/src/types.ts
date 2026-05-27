export type TimeEffectType = 'continuous' | 'deadline' | 'event_bound';
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deferred' | 'cancelled';
export type ReminderStatus = 'pending' | 'triggered' | 'snoozed' | 'dismissed' | 'completed';
export type Actor = 'user' | 'ai' | 'cli' | 'system';
export type Origin = 'gui' | 'ai_page' | 'cli' | 'dream' | 'reminder_system';

export interface Task {
  id: string;
  title: string;
  description: string;
  duration_minutes: number | null;
  due_date: string | null;
  time_effect_type: TimeEffectType;
  status: TaskStatus;
  locked: boolean;
  parent_task_id: string | null;
  project: string | null;
  tags: string[];
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface Event {
  id: string;
  title: string;
  description: string;
  start_time: string;
  end_time: string;
  locked: boolean;
  bound_task_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleBlock {
  id: string;
  task_id: string | null;
  event_id: string | null;
  date: string;
  start_time: string;
  end_time: string;
  locked: boolean;
  manual_signal: boolean;
  created_at: string;
  updated_at: string;
}

export interface Reminder {
  id: string;
  task_id: string | null;
  event_id: string | null;
  trigger_at: string;
  snoozed_until: string | null;
  status: ReminderStatus;
  message: string | null;
  created_at: string;
}

export interface ActionLog {
  id: string;
  capability: string;
  actor: Actor;
  origin: Origin;
  idempotency_key: string | null;
  input_snapshot: string;
  state_before: string | null;
  state_after: string | null;
  description: string | null;
  undo_group_id: string | null;
  created_at: string;
}

export interface CreateTaskInput {
  title: string;
  description?: string;
  duration_minutes?: number;
  due_date?: string;
  time_effect_type?: TimeEffectType;
  parent_task_id?: string;
  project?: string;
  tags?: string[];
}

export interface UpdateTaskInput {
  task_id: string;
  title?: string;
  description?: string;
  duration_minutes?: number;
  due_date?: string;
  time_effect_type?: TimeEffectType;
  project?: string;
  tags?: string[];
}

export interface CreateEventInput {
  title: string;
  start_time: string;
  end_time: string;
  description?: string;
  bound_task_id?: string;
}

export interface UpdateEventInput {
  event_id: string;
  title?: string;
  start_time?: string;
  end_time?: string;
  description?: string;
}

export interface SchedulePlanInput {
  date: string;
}

export interface SchedulePlanRangeInput {
  start_date: string;
  end_date: string;
}
