import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  CalendarDays,
  Check,
  Clock3,
  ListTodo,
  MessageSquareText,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Star,
  Wand2,
} from 'lucide-react';
import { callCapability } from '../lib/tauri';
import { useI18n } from '../lib/i18n';
import BuddyWidget from '../components/BuddyWidget';

interface Task {
  id: string;
  title: string;
  duration_minutes: number | null;
  due_date: string | null;
  status: string;
  locked: boolean;
  project: string | null;
  priority?: number;
}

interface Event {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  locked: boolean;
}

interface ScheduleBlock {
  id: string;
  task_id: string | null;
  event_id: string | null;
  date: string;
  start_time: string;
  end_time: string;
  locked: boolean;
}

interface Reminder {
  id: string;
  task_id: string | null;
  event_id: string | null;
  trigger_at: string;
  message: string | null;
  status: string;
}

const HOURS = Array.from({ length: 12 }, (_, i) => i + 8);

function todayIsoDate() {
  return new Date().toISOString().split('T')[0];
}

function timeOf(value: string | null | undefined) {
  if (!value) {return '';}
  return value.includes('T') ? value.slice(11, 16) : value.slice(0, 5);
}

function minutesBetween(start: string, end: string) {
  const startMs = new Date(start).getTime();
  const endMs = new Date(end).getTime();
  if (Number.isNaN(startMs) || Number.isNaN(endMs)) {return 0;}
  return Math.max(0, Math.round((endMs - startMs) / 60000));
}

export default function TodayPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [schedule, setSchedule] = useState<ScheduleBlock[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [quickAdd, setQuickAdd] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);
  const [aiSuggestionFromAI, setAiSuggestionFromAI] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [quickAddError, setQuickAddError] = useState<string | null>(null);
  const loadingRef = useRef(false);
  const pendingReloadRef = useRef(false);
  const errorTimeoutRef = useRef<ReturnType<typeof setTimeout>>();
  const today = todayIsoDate();
  const { t } = useI18n();

  useEffect(() => {
    loadAllData();
    return () => {
      if (errorTimeoutRef.current) {clearTimeout(errorTimeoutRef.current);}
    };
  }, []);

  async function loadAllData() {
    if (loadingRef.current) {
      pendingReloadRef.current = true;
      return;
    }
    loadingRef.current = true;
    setIsLoading(true);
    setError(null);

    try {
      const [taskResult, eventResult, scheduleResult, reminderResult] = await Promise.all([
        callCapability('task.list', {}) as Promise<{ success: boolean; data?: Task[] }>,
        callCapability('event.list', {
          start: `${today}T00:00:00`,
          end: `${today}T23:59:59`,
        }) as Promise<{ success: boolean; data?: Event[] }>,
        callCapability('schedule.get_blocks', { date: today }) as Promise<{ success: boolean; data?: ScheduleBlock[] }>,
        callCapability('reminder.list', {}) as Promise<{ success: boolean; data?: Reminder[] }>,
      ]);

      setTasks(taskResult.success ? taskResult.data || [] : []);
      setEvents(eventResult.success ? eventResult.data || [] : []);
      setSchedule(scheduleResult.success ? scheduleResult.data || [] : []);
      setReminders(reminderResult.success ? reminderResult.data || [] : []);
    } catch (err) {
      console.error('Failed to load today data:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(message.includes('invoke') ? null : message);
    }

    try {
      const dreamResult = await callCapability('dream.get_insights', { limit: 3 }) as {
        success: boolean;
        data?: { insight_text: string }[];
      };
      if (dreamResult.success && dreamResult.data && dreamResult.data.length > 0) {
        setAiSuggestion(dreamResult.data[0].insight_text);
        setAiSuggestionFromAI(true);
      } else {
        const suggestionResult = await callCapability('ai.suggest_today', { date: today }) as {
          success?: boolean;
          data?: { suggestion?: string };
          suggestion?: string;
        };
        const suggestion = suggestionResult.data?.suggestion || suggestionResult.suggestion;
        setAiSuggestion(suggestion || null);
        setAiSuggestionFromAI(!!suggestion);
      }
    } catch {
      setAiSuggestion(null);
      setAiSuggestionFromAI(false);
    }

    setIsLoading(false);
    loadingRef.current = false;
    if (pendingReloadRef.current) {
      pendingReloadRef.current = false;
      loadAllData();
    }
  }

  async function handleQuickAdd() {
    if (!quickAdd.trim()) {return;}
    const title = quickAdd.trim();
    setQuickAdd('');
    setQuickAddError(null);

    const tempId = `temp_${Date.now()}`;
    const tempTask: Task = {
      id: tempId,
      title,
      duration_minutes: null,
      due_date: null,
      status: 'pending',
      locked: false,
      project: null,
    };
    setTasks((prev) => [tempTask, ...prev]);

    try {
      const result = await callCapability('task.create', { title }) as { success?: boolean; data?: Task };
      setTasks((prev) =>
        prev.map((task) => (task.id === tempId ? { ...task, ...(result.data || {}), id: result.data?.id || task.id } : task)),
      );
      loadAllData();
    } catch (err) {
      setTasks((prev) => prev.filter((task) => task.id !== tempId));
      setQuickAddError(t('today.quick_add_fail') + ': ' + (err instanceof Error ? err.message : String(err)));
      if (errorTimeoutRef.current) {clearTimeout(errorTimeoutRef.current);}
      errorTimeoutRef.current = setTimeout(() => setQuickAddError(null), 3500);
    }
  }

  async function handlePlanDay() {
    setIsLoading(true);
    try {
      const result = await callCapability('schedule.plan_day', { date: today }) as { success: boolean; data?: ScheduleBlock[] };
      if (result.success && result.data) {setSchedule(result.data);}
      await loadAllData();
    } catch (err) {
      console.error('Failed to plan day:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(message.includes('invoke') ? null : message);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleComplete(id: string) {
    try {
      await callCapability('task.complete', { task_id: id });
      setTasks((prev) => prev.map((task) => (task.id === id ? { ...task, status: 'completed' } : task)));
    } catch (err) {
      console.error('Failed to complete task:', err);
    }
  }

  const pendingTasks = useMemo(() => tasks.filter((task) => task.status === 'pending'), [tasks]);
  const completedTasks = useMemo(() => tasks.filter((task) => task.status === 'completed'), [tasks]);
  const todayEvents = useMemo(() => events.filter((event) => event.start_time?.startsWith(today)), [events, today]);
  const todayDeadlineTasks = useMemo(
    () => pendingTasks.filter((task) => task.due_date?.startsWith(today)),
    [pendingTasks, today],
  );
  const importantTask = todayDeadlineTasks[0] || pendingTasks[0] || null;
  const completionRate = tasks.length > 0 ? Math.round((completedTasks.length / tasks.length) * 100) : 0;
  const focusMinutes = useMemo(() => {
    const scheduledMinutes = schedule.reduce((total, block) => total + minutesBetween(block.start_time, block.end_time), 0);
    if (scheduledMinutes > 0) {return scheduledMinutes;}
    return pendingTasks.reduce((total, task) => total + (task.duration_minutes || 0), 0);
  }, [pendingTasks, schedule]);
  const upcomingReminders = reminders
    .filter((reminder) => reminder.status !== 'dismissed')
    .slice(0, 3);

  const scheduleByHour = useMemo(() => {
    const map = new Map<number, ScheduleBlock[]>();
    for (const block of schedule) {
      const hour = Number(timeOf(block.start_time).slice(0, 2));
      if (!Number.isNaN(hour)) {
        const current = map.get(hour) || [];
        current.push(block);
        map.set(hour, current);
      }
    }
    return map;
  }, [schedule]);

  function blockTitle(block: ScheduleBlock) {
    if (block.task_id) {return tasks.find((task) => task.id === block.task_id)?.title || t('today.unknown');}
    if (block.event_id) {return events.find((event) => event.id === block.event_id)?.title || t('today.unknown');}
    return t('today.unknown');
  }

  return (
    <div className="page-shell today-layout">
      <div className="page-header">
        <div className="page-heading">
          <h1>今日</h1>
          <span className="page-subtitle">
            {new Date().toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
          </span>
        </div>
        <div className="toolbar">
          <button className="btn btn-secondary" onClick={loadAllData} disabled={isLoading}>
            <RefreshCw size={16} />
            刷新
          </button>
          <button className="btn btn-primary" onClick={handlePlanDay} disabled={isLoading}>
            <Sparkles size={16} />
            {t('today.auto_schedule')}
          </button>
        </div>
      </div>

      {error && (
        <div className="card" role="alert" style={{ borderColor: 'var(--danger)', color: 'var(--danger-text)' }}>
          {error}
        </div>
      )}

      <div className="metric-grid">
        <MetricCard label="今日任务" value={tasks.length} hint={`待完成 ${pendingTasks.length} · 已完成 ${completedTasks.length}`} />
        <MetricCard label="今日事件" value={todayEvents.length} hint={todayEvents.length > 0 ? '即将开始 1' : '暂无固定事件'} />
        <MetricCard label="专注时间" value={`${(focusMinutes / 60).toFixed(1)}h`} hint="来自排程或任务估算" />
        <MetricCard label="完成度" value={`${completionRate}%`} hint={completionRate >= 60 ? '进度良好' : '还有提升空间'} tone={completionRate >= 60 ? 'good' : 'warn'} />
        <MetricCard label="提醒" value={upcomingReminders.length} hint="待处理提醒" />
      </div>

      <div className="quick-command">
        <input
          type="text"
          placeholder={t('today.quick_add_placeholder')}
          value={quickAdd}
          onChange={(event) => {
            setQuickAdd(event.target.value);
            setQuickAddError(null);
          }}
          onKeyDown={(event) => event.key === 'Enter' && handleQuickAdd()}
          aria-label={t('today.quick_add_placeholder')}
        />
        <button className="btn btn-primary" onClick={handleQuickAdd}>
          <Plus size={16} />
          {t('today.quick_add')}
        </button>
        <button className="btn btn-secondary" onClick={handlePlanDay}>
          <Wand2 size={16} />
          自动规划
        </button>
      </div>
      {quickAddError && <div style={{ color: 'var(--danger-text)', fontSize: 13 }}>{quickAddError}</div>}

      <div className="product-grid">
        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">
              <Clock3 size={17} />
              今日计划
            </h2>
            <span className="panel-meta">总计 {(focusMinutes / 60).toFixed(1)} 小时</span>
          </div>
          <div className="panel-body">
            {schedule.length === 0 ? (
              <div className="empty-panel">{t('today.no_schedule')}</div>
            ) : (
              <div className="timeline">
                {HOURS.map((hour) => {
                  const blocks = scheduleByHour.get(hour) || [];
                  return (
                    <React.Fragment key={hour}>
                      <div className="timeline-hour">{String(hour).padStart(2, '0')}:00</div>
                      <div className="timeline-slot">
                        {blocks.map((block) => (
                          <div
                            key={block.id}
                            className={`timeline-block ${block.event_id ? 'event' : block.locked ? 'generated' : ''}`}
                          >
                            <div className="timeline-block-title">{blockTitle(block)}</div>
                            <div className="timeline-block-time">
                              {timeOf(block.start_time)} - {timeOf(block.end_time)}
                              {block.locked ? ' · 已锁定' : ''}
                            </div>
                          </div>
                        ))}
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            )}
          </div>
        </section>

        <section className="panel">
          <div className="panel-header">
            <h2 className="panel-title">
              <ListTodo size={17} />
              任务清单
            </h2>
            <span className="panel-meta">待完成 {pendingTasks.length}</span>
          </div>
          <div className="panel-body">
            {importantTask && (
              <div className="assistant-message" style={{ marginBottom: 10, borderColor: '#fed7aa', background: '#fff7ed' }}>
                <strong style={{ color: '#c2410c' }}>
                  <Star size={14} style={{ verticalAlign: '-2px' }} /> 优先：
                </strong>{' '}
                {importantTask.title}
              </div>
            )}
            {tasks.length === 0 ? (
              <div className="empty-panel">{t('today.no_pending_tasks')}</div>
            ) : (
              <div className="task-list">
                {tasks.slice(0, 9).map((task) => (
                  <div key={task.id} className="task-row-modern">
                    <button
                      className={`task-check ${task.status === 'completed' ? 'done' : ''}`}
                      onClick={() => task.status !== 'completed' && handleComplete(task.id)}
                      aria-label={t('today.aria_complete_task', { title: task.title })}
                    >
                      {task.status === 'completed' && <Check size={13} />}
                    </button>
                    <div>
                      <div className="task-main-title">{task.title}</div>
                      <div className="task-main-meta">
                        {task.project && <span className="pill">{task.project}</span>}
                        {task.due_date && <span>截止 {task.due_date.slice(5, 10)} {timeOf(task.due_date)}</span>}
                        {task.duration_minutes && <span>{task.duration_minutes / 60 >= 1 ? `${(task.duration_minutes / 60).toFixed(1)}h` : `${task.duration_minutes}min`}</span>}
                      </div>
                    </div>
                    {task.locked && <span className="pill warning">锁定</span>}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>

        <aside className="ai-side-panel">
          <div className="assistant-card">
            <h3>
              <MessageSquareText size={17} style={{ verticalAlign: '-3px', marginRight: 6 }} />
              AI 助手
            </h3>
            <div className="assistant-message">
              {aiSuggestion ? (
                <>
                  {aiSuggestion}
                  {aiSuggestionFromAI && <div className="metric-hint">{t('today.aiGenerated')}</div>}
                </>
              ) : (
                <>AI 服务暂不可用或尚未生成今日建议。你仍然可以管理任务、创建事件，并在配置模型后使用真实 Agent 自动分析日程。</>
              )}
            </div>
            <div className="assistant-actions" style={{ marginTop: 12 }}>
              <button className="mini-action" onClick={handlePlanDay}>
                <BarChart3 size={15} /> 分析今日
              </button>
              <button className="mini-action" onClick={() => setQuickAdd('复盘今天的重点任务')}>
                <ListTodo size={15} /> 任务拆解
              </button>
              <button className="mini-action" onClick={handlePlanDay}>
                <CalendarDays size={15} /> 生成计划
              </button>
              <button className="mini-action" onClick={() => loadAllData()}>
                <RefreshCw size={15} /> 总结回顾
              </button>
            </div>
          </div>

          <div className="assistant-card">
            <h3>即将提醒</h3>
            {upcomingReminders.length === 0 ? (
              <div className="empty-panel" style={{ minHeight: 48 }}>暂无待处理提醒</div>
            ) : (
              upcomingReminders.map((reminder) => (
                <div key={reminder.id} className="task-main-meta" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
                  <span>{reminder.message || '提醒事项'}</span>
                  <span>{timeOf(reminder.trigger_at)}</span>
                </div>
              ))
            )}
          </div>

          <div className="assistant-card">
            <h3>
              <Send size={17} style={{ verticalAlign: '-3px', marginRight: 6 }} />
              快捷入口
            </h3>
            <div className="assistant-message">需要深度对话、工具调用和上下文检查时，进入 AI 页面继续。</div>
          </div>

          <BuddyWidget pendingCount={pendingTasks.length} />
        </aside>
      </div>
    </div>
  );
}

function MetricCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint: string;
  tone?: 'good' | 'warn';
}) {
  return (
    <div className="metric-card">
      <div className="metric-label">{label}</div>
      <div className={`metric-value ${tone === 'good' ? 'metric-good' : tone === 'warn' ? 'metric-warn' : ''}`}>
        {value}
      </div>
      <div className="metric-hint">{hint}</div>
    </div>
  );
}
