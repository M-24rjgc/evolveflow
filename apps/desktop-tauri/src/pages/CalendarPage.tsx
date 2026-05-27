import React, { useState, useEffect, useRef } from 'react';
import { callCapability } from '../lib/tauri';

interface ScheduleBlock {
  id: string;
  task_id: string | null;
  event_id: string | null;
  date: string;
  start_time: string;
  end_time: string;
  locked: boolean;
  manual_signal: boolean;
}

interface TaskItem {
  id: string;
  title: string;
  duration_minutes: number | null;
  due_date: string | null;
  status: string;
  locked: boolean;
}

interface EventItem {
  id: string;
  title: string;
  start_time: string;
  end_time: string;
  locked: boolean;
}

export default function CalendarPage() {
  const [view, setView] = useState<'day' | 'week' | 'month'>('week');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const dragBlockRef = useRef<string | null>(null);

  useEffect(() => {
    loadData();
  }, [currentDate, view]);

  async function loadData() {
    const dateStr = currentDate.toISOString().split('T')[0];
    try {
      const blocksResult = await callCapability('schedule.plan_day', { date: dateStr }) as { success: boolean; data?: ScheduleBlock[] };
      if (blocksResult.success && blocksResult.data) setBlocks(blocksResult.data);

      const taskResult = await callCapability('task.list', {}) as { success: boolean; data?: TaskItem[] };
      if (taskResult.success && taskResult.data) {
        setTasks(taskResult.data);
        const taskEvents: EventItem[] = taskResult.data
          .filter((t) => t.duration_minutes && t.due_date?.startsWith(dateStr))
          .map((t) => ({
            id: t.id,
            title: t.title,
            start_time: `${t.due_date?.slice(0, 10) || dateStr}T09:00:00`,
            end_time: `${t.due_date?.slice(0, 10) || dateStr}T${String(9 + Math.ceil((t.duration_minutes || 30) / 60)).padStart(2, '0')}:00:00`,
            locked: t.locked,
          }));
        setEvents(taskEvents);
      }
    } catch (err) { console.error('Failed to load calendar data:', err); }
  }

  function getWeekDays() {
    const start = new Date(currentDate);
    start.setDate(start.getDate() - start.getDay());
    const days = [];
    for (let i = 0; i < 7; i++) {
      const day = new Date(start);
      day.setDate(start.getDate() + i);
      days.push(day);
    }
    return days;
  }

  function getMonthDays() {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days = [];
    for (let d = firstDay.getDate(); d <= lastDay.getDate(); d++) {
      days.push(new Date(year, month, d));
    }
    return days;
  }

  function getDayBlocks(day: Date): ScheduleBlock[] {
    const dateStr = day.toISOString().split('T')[0];
    return blocks.filter((b) => b.date === dateStr);
  }

  function hasConflict(block: ScheduleBlock): boolean {
    const sameDateBlocks = blocks.filter((b) => b.date === block.date && b.id !== block.id);
    return sameDateBlocks.some((b) => {
      return block.start_time < b.end_time && block.end_time > b.start_time;
    });
  }

  async function handleLock(blockId: string, locked: boolean) {
    const block = blocks.find((b) => b.id === blockId);
    if (!block) return;
    if (block.task_id) {
      await callCapability('task.lock', { task_id: block.task_id, locked });
    }
    if (block.event_id) {
      await callCapability('event.lock', { event_id: block.event_id, locked });
    }
    loadData();
  }

  function handleDragStart(blockId: string) {
    dragBlockRef.current = blockId;
  }

  function handleDrop(newHour: number) {
    const blockId = dragBlockRef.current;
    if (!blockId) return;

    setBlocks((prev) => {
      const block = prev.find((b) => b.id === blockId);
      if (!block) return prev;
      const startHour = Math.min(newHour, 23);
      const duration = (new Date(block.end_time).getTime() - new Date(block.start_time).getTime()) / 3600000;
      const newStart = `${block.date}T${String(startHour).padStart(2, '0')}:00:00`;
      const newEnd = `${block.date}T${String(Math.min(startHour + Math.ceil(duration), 23)).padStart(2, '0')}:00:00`;
      return prev.map((b) =>
        b.id === blockId ? { ...b, start_time: newStart, end_time: newEnd, manual_signal: true } : b
      );
    });
    dragBlockRef.current = null;
  }

  const today = currentDate.toISOString().split('T')[0];
  const weekDays = getWeekDays();
  const monthDays = getMonthDays();

  const hours = Array.from({ length: 12 }, (_, i) => i + 7);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
        <h1 className="page-title" style={{ marginBottom: 0 }}>日历</h1>
        <button className="btn btn-secondary" onClick={() => setCurrentDate(new Date())}>今天</button>
        <button className="btn btn-secondary" onClick={() => {
          const d = new Date(currentDate);
          d.setDate(d.getDate() - (view === 'month' ? 30 : 7));
          setCurrentDate(d);
        }}>◀</button>
        <span style={{ fontWeight: 600 }}>{currentDate.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long' })}</span>
        <button className="btn btn-secondary" onClick={() => {
          const d = new Date(currentDate);
          d.setDate(d.getDate() + (view === 'month' ? 30 : 7));
          setCurrentDate(d);
        }}>▶</button>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`btn ${view === 'day' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('day')}>日视图</button>
        <button className={`btn ${view === 'week' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('week')}>周视图</button>
        <button className={`btn ${view === 'month' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setView('month')}>月视图</button>
      </div>

      {/* Day View */}
      {view === 'day' && (
        <div className="card" style={{ overflow: 'auto' }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>
            {currentDate.toLocaleDateString('zh-CN', { weekday: 'long', month: 'long', day: 'numeric' })}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
            {hours.map((h) => {
              const hourStr = `${today}T${String(h).padStart(2, '0')}:00:00`;
              const nextHour = `${today}T${String(h + 1).padStart(2, '0')}:00:00`;
              const hourBlocks = blocks.filter((b) => b.start_time >= hourStr && b.start_time < nextHour);
              const hasConflicts = hourBlocks.some((b) => hasConflict(b));

              return (
                <div
                  key={h}
                  style={{
                    display: 'flex', minHeight: 48, borderBottom: '1px solid #eee',
                    background: hasConflicts ? '#fff0f0' : 'transparent',
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => handleDrop(h)}
                >
                  <div style={{ width: 60, color: '#888', fontSize: 12, paddingTop: 4 }}>
                    {String(h).padStart(2, '0')}:00
                  </div>
                  <div style={{ flex: 1, padding: '2px 4px' }}>
                    {hourBlocks.map((b) => {
                      const isEvent = b.event_id !== null;
                      const blockTask = tasks.find((t) => t.id === b.task_id);
                      return (
                        <div
                          key={b.id}
                          draggable
                          onDragStart={() => handleDragStart(b.id)}
                          style={{
                            padding: '4px 8px', marginBottom: 2, borderRadius: 4, cursor: 'grab',
                            background: isEvent ? '#e8f0fe' : '#f0f4ff',
                            borderLeft: `3px solid ${isEvent ? '#3b82f6' : '#4a6fa5'}`,
                            fontSize: 12, display: 'flex', alignItems: 'center', gap: 6,
                          }}
                        >
                          <span style={{ flex: 1 }}>{blockTask?.title || b.id.slice(0, 8)}</span>
                          {b.locked && <span style={{ color: '#f59e0b' }}>🔒</span>}
                          {hasConflict(b) && <span style={{ color: '#ef4444', fontWeight: 700 }}>⚠冲突</span>}
                          <button
                            className="btn btn-secondary"
                            style={{ fontSize: 10, padding: '1px 6px' }}
                            onClick={() => handleLock(b.id, !b.locked)}
                          >{b.locked ? '解锁' : '锁定'}</button>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 12, fontSize: 12, color: '#888' }}>
            提示：拖拽任务块可调整时间 | 🔒 表示已锁定 | ⚠ 表示时间冲突 | 点击锁定按钮可锁定/解锁
          </div>
        </div>
      )}

      {/* Week View */}
      {view === 'week' && (
        <div className="card" style={{ overflow: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: `60px repeat(7, 1fr)`, gap: 1, fontSize: 12 }}>
            <div></div>
            {weekDays.map((day, i) => (
              <div key={i} style={{ fontWeight: 600, textAlign: 'center', padding: 4 }}>
                {['日', '一', '二', '三', '四', '五', '六'][day.getDay()]}
                <br />{day.getDate()}
              </div>
            ))}
            {hours.map((h) => (
              <React.Fragment key={h}>
                <div style={{ color: '#888', paddingTop: 2 }}>{String(h).padStart(2, '0')}:00</div>
                {weekDays.map((day, i) => {
                  const dateStr = day.toISOString().split('T')[0];
                  const hourStr = `${dateStr}T${String(h).padStart(2, '0')}:00:00`;
                  const nextHour = `${dateStr}T${String(h + 1).padStart(2, '0')}:00:00`;
                  const dayBlocks = blocks.filter((b) => b.date === dateStr && b.start_time >= hourStr && b.start_time < nextHour);

                  return (
                    <div
                      key={i}
                      style={{
                        borderBottom: '1px solid #f0f0f0', minHeight: 36, padding: 1,
                        background: dayBlocks.some((b) => hasConflict(b)) ? '#fff0f0' : 'transparent',
                      }}
                    >
                      {dayBlocks.map((b) => (
                        <div
                          key={b.id}
                          style={{
                            padding: '2px 4px', borderRadius: 2, marginBottom: 1, fontSize: 10,
                            background: b.event_id ? '#e8f0fe' : '#f0f4ff',
                            borderLeft: `2px solid ${b.event_id ? '#3b82f6' : '#4a6fa5'}`,
                            cursor: 'pointer',
                          }}
                          title={`${b.start_time.slice(11, 16)}-${b.end_time.slice(11, 16)}`}
                        >
                          {b.task_id && tasks.find((t) => t.id === b.task_id)?.title?.slice(0, 6) || '任务'}
                          {b.locked && <span>🔒</span>}
                        </div>
                      ))}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      )}

      {/* Month View */}
      {view === 'month' && (
        <div className="card" style={{ overflow: 'auto' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, fontSize: 12 }}>
            {['日', '一', '二', '三', '四', '五', '六'].map((d) => (
              <div key={d} style={{ fontWeight: 600, textAlign: 'center', padding: 4 }}>{d}</div>
            ))}
            {monthDays.map((day) => {
              const dateStr = day.toISOString().split('T')[0];
              const dayBlocks = blocks.filter((b) => b.date === dateStr);
              const isToday = dateStr === today;

              return (
                <div
                  key={dateStr}
                  style={{
                    border: '1px solid #eee', minHeight: 60, padding: 4, borderRadius: 4,
                    background: isToday ? '#f0f4ff' : 'white',
                  }}
                >
                  <div style={{ fontWeight: isToday ? 700 : 400, color: isToday ? '#4a6fa5' : '#333' }}>
                    {day.getDate()}
                  </div>
                  {dayBlocks.slice(0, 2).map((b) => (
                    <div key={b.id} style={{
                      fontSize: 10, padding: '1px 2px', marginBottom: 1, borderRadius: 2, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      background: b.event_id ? '#e8f0fe' : '#f0f4ff',
                    }}>
                      {b.task_id && tasks.find((t) => t.id === b.task_id)?.title || '任务'}
                    </div>
                  ))}
                  {dayBlocks.length > 2 && (
                    <div style={{ fontSize: 10, color: '#888' }}>+{dayBlocks.length - 2} 更多</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}