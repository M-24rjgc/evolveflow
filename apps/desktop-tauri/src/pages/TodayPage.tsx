import React, { useState, useEffect, useRef } from 'react';
import { callCapability } from '../lib/tauri';

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

export default function TodayPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [events, setEvents] = useState<Event[]>([]);
  const [schedule, setSchedule] = useState<ScheduleBlock[]>([]);
  const [reminders, setReminders] = useState<Reminder[]>([]);
  const [quickAdd, setQuickAdd] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState<string | null>(null);

  const loadingRef = useRef(false);
  const pendingReloadRef = useRef(false);

  const today = new Date().toISOString().split('T')[0];

  useEffect(() => {
    loadAllData();
  }, []);

  async function loadAllData() {
    if (loadingRef.current) {
      pendingReloadRef.current = true;
      return;
    }
    loadingRef.current = true;
    setIsLoading(true);
    try {
      const taskResult = await callCapability('task.list', {}) as { success: boolean; data?: Task[] };
      if (taskResult.success && taskResult.data) setTasks(taskResult.data);

      const eventResult = await callCapability('event.list', {
        start: `${today}T00:00:00`,
        end: `${today}T23:59:59`,
      }) as { success: boolean; data?: Event[] };
      if (eventResult.success && eventResult.data) setEvents(eventResult.data);

      const pendingTasks = taskResult.data?.filter((t) => t.status === 'pending') || [];
      if (pendingTasks.length > 0) {
        const urgentTask = pendingTasks.find((t) => t.due_date?.startsWith(today));
        if (urgentTask) {
          setAiSuggestion(`你有任务"${urgentTask.title}"今天截止，建议优先完成。`);
        } else if (pendingTasks.length <= 3) {
          setAiSuggestion(`今天有 ${pendingTasks.length} 个待办任务，节奏不错！`);
        } else {
          setAiSuggestion(`今天有 ${pendingTasks.length} 个待办任务，建议使用自动排程合理分配时间。`);
        }
      } else {
        setAiSuggestion('今天没有待办任务，要不要创建一个？');
      }
    } catch (err) {
      console.error('Failed to load data:', err);
    } finally {
      setIsLoading(false);
      loadingRef.current = false;
      if (pendingReloadRef.current) {
        pendingReloadRef.current = false;
        loadAllData();
      }
    }
  }

  async function handleQuickAdd() {
    if (!quickAdd.trim()) return;
    try {
      await callCapability('task.create', { title: quickAdd });
      setQuickAdd('');
      loadAllData();
    } catch (err) {
      console.error('Failed to add task:', err);
    }
  }

  async function handlePlanDay() {
    try {
      const result = await callCapability('schedule.plan_day', { date: today }) as { success: boolean; data?: ScheduleBlock[] };
      if (result.success && result.data) setSchedule(result.data);
    } catch (err) {
      console.error('Failed to plan day:', err);
    }
  }

  async function handleComplete(id: string) {
    await callCapability('task.complete', { task_id: id });
    loadAllData();
  }

  const pendingTasks = tasks.filter((t) => t.status === 'pending');
  const todayDeadlineTasks = pendingTasks.filter((t) => t.due_date?.startsWith(today));
  const mostImportantTask = todayDeadlineTasks.length > 0
    ? todayDeadlineTasks.sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''))[0]
    : pendingTasks.sort((a, b) => (a.due_date || '9999').localeCompare(b.due_date || '9999'))[0] || null;

  const todayEvents = events.filter((e) => e.start_time?.startsWith(today));

  const upcomingReminders = pendingTasks
    .filter((t) => t.due_date?.startsWith(today))
    .map((t) => ({ id: t.id, title: t.title, due: t.due_date?.slice(11, 16) || '今天' }));

  return (
    <div>
      <h1 className="page-title">今天的智能日程</h1>

      {isLoading && <div className="loading-spinner"></div>}

      {/* Quick Add + Actions */}
      <div className="quick-add">
        <input type="text" placeholder="快速添加任务..." value={quickAdd} onChange={(e) => setQuickAdd(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && handleQuickAdd()} />
        <button className="btn btn-primary" onClick={handleQuickAdd}>添加</button>
        <button className="btn btn-secondary" onClick={handlePlanDay}>自动排程</button>
      </div>

      {/* Most Important Task */}
      {mostImportantTask && (
        <div className="card" style={{ borderLeft: '4px solid #ef4444' }}>
          <h3 className="card-title" style={{ color: '#ef4444' }}>⭐ 最重要任务</h3>
          <div className="task-item" style={{ background: '#fef2f2' }}>
            <span className="task-title" style={{ fontWeight: 600 }}>{mostImportantTask.title}</span>
            {mostImportantTask.due_date && (
              <span className="task-time" style={{ marginLeft: 12 }}>
                {mostImportantTask.due_date.startsWith(today) ? '今天截止' : `截止: ${mostImportantTask.due_date.slice(0, 10)}`}
              </span>
            )}
            <button className="btn btn-primary" style={{ marginLeft: 12, fontSize: 12, padding: '4px 12px' }}
              onClick={() => handleComplete(mostImportantTask.id)}>完成</button>
          </div>
        </div>
      )}

      {/* Today's Events */}
      <div className="card">
        <h3 className="card-title">📅 今日事件</h3>
        {todayEvents.length === 0 ? (
          <p style={{ color: '#888', fontSize: 14 }}>今天没有固定事件</p>
        ) : (
          todayEvents.map((event) => (
            <div key={event.id} className="event-item">
              <span style={{ fontSize: 12, color: '#3b82f6', fontWeight: 600, minWidth: 80 }}>
                {event.start_time.slice(11, 16)} - {event.end_time.slice(11, 16)}
              </span>
              <span className="task-title">{event.title}</span>
              {event.locked && <span style={{ fontSize: 12, color: '#f59e0b' }}>🔒</span>}
            </div>
          ))
        )}
      </div>

      {/* Upcoming Reminders */}
      {upcomingReminders.length > 0 && (
        <div className="card" style={{ borderLeft: '4px solid #f59e0b' }}>
          <h3 className="card-title" style={{ color: '#f59e0b' }}>⏰ 即将到来的提醒</h3>
          {upcomingReminders.map((r) => (
            <div key={r.id} style={{ display: 'flex', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #fef3c7' }}>
              <span style={{ fontSize: 13, fontWeight: 500, minWidth: 60, color: '#92400e' }}>{r.due}</span>
              <span style={{ fontSize: 13 }}>{r.title}</span>
            </div>
          ))}
        </div>
      )}

      {/* Schedule */}
      {schedule.length > 0 && (
        <div className="card">
          <h3 className="card-title">今日排程</h3>
          {schedule.map((block) => (
            <div key={block.id} className={block.event_id ? 'event-item' : 'task-item'} style={{ justifyContent: 'space-between' }}>
              <span style={{ fontSize: 12, fontWeight: 600 }}>
                {block.start_time.slice(11, 16)} - {block.end_time.slice(11, 16)}
              </span>
              <span style={{ fontSize: 13 }}>
                {block.task_id && tasks.find((t) => t.id === block.task_id)?.title || '未知'}
                {block.event_id && events.find((e) => e.id === block.event_id)?.title || ''}
              </span>
              {block.locked && <span style={{ fontSize: 12, color: '#f59e0b' }}>🔒</span>}
            </div>
          ))}
        </div>
      )}

      {/* AI Suggestions */}
      {aiSuggestion && (
        <div className="ai-suggestion">
          <span style={{ fontWeight: 600, color: '#4a6fa5' }}>💡 AI 建议：</span>
          {aiSuggestion}
        </div>
      )}

      {/* Buddy */}
      <div className="buddy-box">
        <div className="buddy-icon">B</div>
        <span style={{ fontSize: 14 }}>
          {pendingTasks.length === 0 ? '今天很轻松，享受吧！' :
           schedule.length > 0 ? '排程已完成，按计划执行就好！' :
           '需要我帮你安排今天吗？点击"自动排程"按钮'}
        </span>
      </div>
    </div>
  );
}