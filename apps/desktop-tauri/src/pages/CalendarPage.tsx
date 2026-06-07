import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CalendarClock,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Lock,
  Plus,
  Trash2,
  Unlock,
} from 'lucide-react';
import { callCapability } from '../lib/tauri';
import { useI18n } from '../lib/i18n';
import EventEditModal from '../components/EventEditModal';
import { EmptyPanel, MetricCard, PageHeader, PageShell, Panel, SegmentedTabs } from '../components/PageChrome';

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
  description?: string;
  start_time: string;
  end_time: string;
  locked: boolean;
  bound_task_id: string | null;
}

type CalendarView = 'day' | 'week' | 'month';

function isoDate(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatTime(isoStr: string): string {
  return isoStr.slice(11, 16);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

export default function CalendarPage() {
  const { t, locale } = useI18n();
  const [view, setView] = useState<CalendarView>('week');
  const [currentDate, setCurrentDate] = useState(new Date());
  const [blocks, setBlocks] = useState<ScheduleBlock[]>([]);
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [events, setEvents] = useState<EventItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedDate, setExpandedDate] = useState<string | null>(null);
  const dragBlockRef = useRef<string | null>(null);

  const [showEventForm, setShowEventForm] = useState(false);
  const [showEventEditModal, setShowEventEditModal] = useState(false);
  const [editingEvent, setEditingEvent] = useState<EventItem | null>(null);
  const [deleteConfirmEventId, setDeleteConfirmEventId] = useState<string | null>(null);
  const [newEventTitle, setNewEventTitle] = useState('');
  const [newEventStart, setNewEventStart] = useState('');
  const [newEventEnd, setNewEventEnd] = useState('');
  const [isSavingEvent, setIsSavingEvent] = useState(false);

  const visibleDays = useMemo(() => {
    if (view === 'day') {return [new Date(currentDate)];}
    if (view === 'week') {
      const start = new Date(currentDate);
      start.setDate(start.getDate() - start.getDay());
      return Array.from({ length: 7 }, (_, index) => addDays(start, index));
    }
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const first = new Date(year, month, 1);
    const last = new Date(year, month + 1, 0);
    return Array.from({ length: last.getDate() }, (_, index) => new Date(year, month, index + 1));
  }, [currentDate, view]);

  useEffect(() => {
    loadData();
  }, [currentDate, view]);

  async function loadData() {
    setIsLoading(true);
    setError(null);
    try {
      const startStr = isoDate(visibleDays[0] || currentDate);
      const endStr = isoDate(visibleDays[visibleDays.length - 1] || currentDate);
      const [blockResults, taskResult, eventResult] = await Promise.all([
        Promise.all(visibleDays.map((day) => callCapability('schedule.get_blocks', { date: isoDate(day) }) as Promise<{ success: boolean; data?: ScheduleBlock[] }>)),
        callCapability('task.list', {}) as Promise<{ success: boolean; data?: TaskItem[] }>,
        callCapability('event.list', {
          start: `${startStr}T00:00:00`,
          end: `${endStr}T23:59:59`,
        }) as Promise<{ success: boolean; data?: EventItem[] }>,
      ]);

      setBlocks(blockResults.flatMap((result) => (result.success && result.data ? result.data : [])));
      setTasks(taskResult.success && taskResult.data ? taskResult.data : []);
      setEvents(eventResult.success && eventResult.data ? eventResult.data : []);
    } catch (err) {
      console.error('Failed to load calendar data:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(message.includes('invoke') ? null : t('calendar.load_error'));
    } finally {
      setIsLoading(false);
    }
  }

  const monthCells = useMemo<(Date | null)[]>(() => {
    const year = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const firstDay = new Date(year, month, 1);
    const lastDay = new Date(year, month + 1, 0);
    const days: (Date | null)[] = [];
    for (let i = 0; i < firstDay.getDay(); i++) {days.push(null);}
    for (let day = 1; day <= lastDay.getDate(); day++) {days.push(new Date(year, month, day));}
    return days;
  }, [currentDate]);

  function getDayBlocks(day: Date): ScheduleBlock[] {
    const dateStr = isoDate(day);
    return blocks.filter((block) => block.date === dateStr);
  }

  function getDayEvents(day: Date): EventItem[] {
    const dateStr = isoDate(day);
    return events.filter((eventItem) => eventItem.start_time.startsWith(dateStr) || eventItem.end_time.startsWith(dateStr));
  }

  function hasConflict(block: ScheduleBlock): boolean {
    const sameDateBlocks = blocks.filter((candidate) => candidate.date === block.date && candidate.id !== block.id);
    return sameDateBlocks.some((candidate) => block.start_time < candidate.end_time && block.end_time > candidate.start_time);
  }

  async function handleLock(blockId: string, locked: boolean) {
    const block = blocks.find((candidate) => candidate.id === blockId);
    if (!block) {return;}
    if (block.task_id) {await callCapability('task.lock', { task_id: block.task_id, locked });}
    if (block.event_id) {await callCapability('event.lock', { event_id: block.event_id, locked });}
    loadData();
  }

  function handleDragStart(blockId: string) {
    dragBlockRef.current = blockId;
  }

  async function handleDrop(day: Date, newHour: number) {
    const blockId = dragBlockRef.current;
    if (!blockId) {return;}
    const block = blocks.find((candidate) => candidate.id === blockId);
    if (!block) {return;}

    const dateStr = isoDate(day);
    const startHour = Math.min(newHour, 23);
    const durationHours = (new Date(block.end_time).getTime() - new Date(block.start_time).getTime()) / 3600000;
    const newStart = `${dateStr}T${String(startHour).padStart(2, '0')}:00:00`;
    const newEnd = `${dateStr}T${String(Math.min(startHour + Math.ceil(durationHours), 23)).padStart(2, '0')}:00:00`;

    setBlocks((prev) =>
      prev.map((candidate) =>
        candidate.id === blockId
          ? { ...candidate, date: dateStr, start_time: newStart, end_time: newEnd, manual_signal: true }
          : candidate,
      ),
    );

    try {
      if (block.task_id) {
        await callCapability('task.update', {
          task_id: block.task_id,
          start_time: newStart,
          end_time: newEnd,
          manual_signal: true,
        });
      } else if (block.event_id) {
        await callCapability('event.update', {
          event_id: block.event_id,
          start_time: newStart,
          end_time: newEnd,
        });
      }
    } catch {
      loadData();
    }
    dragBlockRef.current = null;
  }

  function handleOpenCreateForm() {
    const now = new Date();
    const offset = now.getTimezoneOffset();
    const local = new Date(now.getTime() - offset * 60000);
    setNewEventTitle('');
    setNewEventStart(local.toISOString().slice(0, 16));
    setNewEventEnd(new Date(local.getTime() + 3600000).toISOString().slice(0, 16));
    setShowEventForm(true);
  }

  async function handleCreateEvent() {
    if (!newEventTitle.trim() || !newEventStart || !newEventEnd) {return;}
    setIsSavingEvent(true);
    try {
      const result = await callCapability('event.create', {
        title: newEventTitle.trim(),
        start_time: `${newEventStart}:00`,
        end_time: `${newEventEnd}:00`,
      }) as { success: boolean; data?: EventItem };
      if (result.success) {
        setShowEventForm(false);
        setNewEventTitle('');
        loadData();
      } else {
        setError(t('calendar.create_error'));
      }
    } catch {
      setError(t('calendar.create_error'));
    } finally {
      setIsSavingEvent(false);
    }
  }

  function handleEditEvent(eventItem: EventItem) {
    setEditingEvent(eventItem);
    setShowEventEditModal(true);
  }

  function handleEventSaved() {
    loadData();
    setShowEventEditModal(false);
    setEditingEvent(null);
  }

  async function handleDeleteEvent(eventId: string) {
    try {
      const result = await callCapability('event.delete', { event_id: eventId }) as { success: boolean };
      if (result.success) {loadData();}
      else {setError(t('calendar.delete_error'));}
    } catch {
      setError(t('calendar.delete_error'));
    }
    setDeleteConfirmEventId(null);
  }

  async function handleClearGeneratedSchedule(date: Date = currentDate) {
    const dateStr = isoDate(date);
    const confirmed = window.confirm(t('calendar.confirm_clear_schedule'));
    if (!confirmed) {return;}
    setIsLoading(true);
    setError(null);
    try {
      const result = await callCapability('schedule.clear_day', { date: dateStr }) as { success: boolean; error?: string };
      if (result.success) {
        await loadData();
      } else {
        setError(result.error || t('calendar.clear_schedule_error'));
      }
    } catch {
      setError(t('calendar.clear_schedule_error'));
    } finally {
      setIsLoading(false);
    }
  }

  function blockTitle(block: ScheduleBlock) {
    if (block.task_id) {return tasks.find((task) => task.id === block.task_id)?.title || t('calendar.task_label');}
    if (block.event_id) {return events.find((eventItem) => eventItem.id === block.event_id)?.title || t('calendar.events_section');}
    return block.id.slice(0, 8);
  }

  const hours = Array.from({ length: 13 }, (_, index) => index + 7);
  const weekdayNames = locale === 'zh-CN'
    ? ['日', '一', '二', '三', '四', '五', '六']
    : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const conflictCount = blocks.filter((block) => hasConflict(block)).length;
  const visibleEventsCount = events.length;
  const pendingTasks = tasks.filter((task) => task.status === 'pending').length;

  function renderEventCreateForm() {
    if (!showEventForm) {return null;}
    return (
      <Panel title={t('calendar.new_event')} icon={<CalendarClock size={17} />}>
        <div className="field-grid">
          <label className="field-row" style={{ gridColumn: '1 / -1' }}>
            {t('calendar.event_title_placeholder')}
            <input
              type="text"
              value={newEventTitle}
              onChange={(event) => setNewEventTitle(event.target.value)}
              placeholder={t('calendar.event_title_placeholder')}
            />
          </label>
          <label className="field-row">
            {t('calendar.start_time')}
            <input type="datetime-local" value={newEventStart} onChange={(event) => setNewEventStart(event.target.value)} />
          </label>
          <label className="field-row">
            {t('calendar.end_time')}
            <input type="datetime-local" value={newEventEnd} onChange={(event) => setNewEventEnd(event.target.value)} />
          </label>
        </div>
        <div className="task-action-row" style={{ marginTop: 12 }}>
          <button className="btn btn-secondary" onClick={() => setShowEventForm(false)} disabled={isSavingEvent}>
            {t('common.cancel')}
          </button>
          <button
            className="btn btn-primary"
            onClick={handleCreateEvent}
            disabled={isSavingEvent || !newEventTitle.trim() || !newEventStart || !newEventEnd}
          >
            {isSavingEvent && <span className="loading-spinner" style={{ width: 14, height: 14, margin: 0 }} />}
            {isSavingEvent ? t('calendar.saving') : t('common.save')}
          </button>
        </div>
      </Panel>
    );
  }

  function renderCalendarBlock(block: ScheduleBlock, compact = false) {
    const conflicted = hasConflict(block);
    return (
      <div
        key={block.id}
        draggable={!compact}
        onDragStart={() => handleDragStart(block.id)}
        className={`calendar-block ${block.event_id ? 'event' : ''} ${conflicted ? 'warn' : ''}`}
        title={`${blockTitle(block)} ${formatTime(block.start_time)}-${formatTime(block.end_time)}`}
      >
        {blockTitle(block)}
        {!compact && ` · ${formatTime(block.start_time)}-${formatTime(block.end_time)}`}
        {block.locked && ' · locked'}
      </div>
    );
  }

  function renderEventChip(eventItem: EventItem, compact = false) {
    return (
      <div
        key={eventItem.id}
        className="calendar-block event"
        title={`${eventItem.title} ${formatTime(eventItem.start_time)}-${formatTime(eventItem.end_time)}`}
        onClick={(event) => {
          event.stopPropagation();
          handleEditEvent(eventItem);
        }}
      >
        {compact ? eventItem.title : `${eventItem.title} · ${formatTime(eventItem.start_time)}-${formatTime(eventItem.end_time)}`}
      </div>
    );
  }

  function renderDayView() {
    const day = currentDate;
    const dayBlocks = getDayBlocks(day);
    const dayEvents = getDayEvents(day);
    return (
      <Panel
        title={day.toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' })}
        meta={`${dayBlocks.length + dayEvents.length} items`}
        icon={<Clock3 size={17} />}
      >
        {dayBlocks.length === 0 && dayEvents.length === 0 ? (
          <EmptyPanel>{t('calendar.no_schedule_day')}</EmptyPanel>
        ) : (
          <div className="calendar-day-grid">
            {hours.map((hour) => {
              const hourStart = `${isoDate(day)}T${String(hour).padStart(2, '0')}:00:00`;
              const hourEnd = `${isoDate(day)}T${String(hour + 1).padStart(2, '0')}:00:00`;
              const hourBlocks = dayBlocks.filter((block) => block.start_time >= hourStart && block.start_time < hourEnd);
              const hourEvents = dayEvents.filter((eventItem) => eventItem.start_time >= hourStart && eventItem.start_time < hourEnd);
              return (
                <div
                  key={hour}
                  className="calendar-hour-row"
                  onDragOver={(event) => event.preventDefault()}
                  onDrop={() => handleDrop(day, hour)}
                >
                  <div className="calendar-hour-label">{String(hour).padStart(2, '0')}:00</div>
                  <div className="calendar-hour-content">
                    {hourBlocks.map((block) => (
                      <div key={block.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
                        {renderCalendarBlock(block)}
                        <button className="btn btn-secondary icon-button" onClick={() => handleLock(block.id, !block.locked)} aria-label={block.locked ? t('calendar.unlock') : t('calendar.lock')}>
                          {block.locked ? <Lock size={16} /> : <Unlock size={16} />}
                        </button>
                      </div>
                    ))}
                    {hourEvents.map((eventItem) => (
                      <div key={eventItem.id} style={{ display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'center' }}>
                        {renderEventChip(eventItem)}
                        <button className="btn btn-secondary icon-button" onClick={() => setDeleteConfirmEventId(eventItem.id)} aria-label={t('calendar.aria_delete_event', { title: eventItem.title })} style={{ color: 'var(--danger-text)' }}>
                          <Trash2 size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
        <div className="field-help" style={{ marginTop: 12 }}>{t('calendar.drag_hint')}</div>
      </Panel>
    );
  }

  function renderWeekView() {
    return (
      <Panel title={t('calendar.week_view')} meta={currentDate.toLocaleDateString(locale, { year: 'numeric', month: 'long' })} icon={<CalendarDays size={17} />}>
        <div className="calendar-frame">
          <div className="calendar-week-grid" role="grid" aria-label={t('calendar.week_view')}>
            <div />
            {visibleDays.map((day) => (
              <div key={isoDate(day)} role="columnheader" style={{ padding: '8px 4px', textAlign: 'center', fontWeight: 700, color: 'var(--text-secondary)' }}>
                {weekdayNames[day.getDay()]}<br />{day.getDate()}
              </div>
            ))}
            {hours.map((hour) => (
              <React.Fragment key={hour}>
                <div className="calendar-hour-label">{String(hour).padStart(2, '0')}:00</div>
                {visibleDays.map((day) => {
                  const hourStart = `${isoDate(day)}T${String(hour).padStart(2, '0')}:00:00`;
                  const hourEnd = `${isoDate(day)}T${String(hour + 1).padStart(2, '0')}:00:00`;
                  const dayBlocks = getDayBlocks(day).filter((block) => block.start_time >= hourStart && block.start_time < hourEnd);
                  const dayEvents = getDayEvents(day).filter((eventItem) => eventItem.start_time >= hourStart && eventItem.start_time < hourEnd);
                  return (
                    <div key={`${isoDate(day)}-${hour}`} className="calendar-cell" role="gridcell">
                      {dayBlocks.map((block) => renderCalendarBlock(block, true))}
                      {dayEvents.map((eventItem) => renderEventChip(eventItem, true))}
                    </div>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
        </div>
      </Panel>
    );
  }

  function renderMonthView() {
    return (
      <Panel title={t('calendar.month_view')} meta={currentDate.toLocaleDateString(locale, { year: 'numeric', month: 'long' })} icon={<CalendarDays size={17} />}>
        <div className="calendar-frame">
          <div className="calendar-month-grid" role="grid" aria-label={t('calendar.month_view')}>
            {weekdayNames.map((dayName) => (
              <div key={dayName} role="columnheader" style={{ textAlign: 'center', fontWeight: 700, color: 'var(--text-muted)' }}>{dayName}</div>
            ))}
            {monthCells.map((day, index) => {
              if (!day) {return <div key={`empty-${index}`} className="calendar-cell muted" role="gridcell" />;}
              const dateStr = isoDate(day);
              const isToday = dateStr === isoDate(new Date());
              const dayBlocks = getDayBlocks(day);
              const dayEvents = getDayEvents(day);
              const allItems = [
                ...dayBlocks.map((block) => ({ kind: 'block' as const, block })),
                ...dayEvents.map((eventItem) => ({ kind: 'event' as const, eventItem })),
              ];
              const isExpanded = expandedDate === dateStr;
              const visibleItems = isExpanded ? allItems : allItems.slice(0, 3);

              return (
                <div
                  key={dateStr}
                  className={`calendar-cell ${isToday ? 'today' : ''}`}
                  role="gridcell"
                  onClick={() => setExpandedDate(isExpanded ? null : dateStr)}
                >
                  <div style={{ fontWeight: isToday ? 800 : 650, color: isToday ? 'var(--accent-color)' : 'var(--text-primary)', marginBottom: 5 }}>
                    {day.getDate()}
                  </div>
                  {visibleItems.map((item) => item.kind === 'block' ? renderCalendarBlock(item.block, true) : renderEventChip(item.eventItem, true))}
                  {allItems.length > visibleItems.length && (
                    <div className="field-help">+{allItems.length - visibleItems.length} {t('calendar.more')}</div>
                  )}
                  {isExpanded && allItems.length > 3 && <div className="field-help">{t('calendar.collapse')}</div>}
                </div>
              );
            })}
          </div>
        </div>
      </Panel>
    );
  }

  function renderDeleteConfirm() {
    if (!deleteConfirmEventId) {return null;}
    return (
      <div
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 9500,
          background: 'rgba(15, 23, 42, 0.38)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 20,
        }}
        onClick={() => setDeleteConfirmEventId(null)}
      >
        <div className="panel" style={{ width: 400 }} onClick={(event) => event.stopPropagation()}>
          <div className="panel-header">
            <h2 className="panel-title"><Trash2 size={17} />{t('calendar.confirm_delete_event')}</h2>
          </div>
          <div className="panel-body">
            <p className="field-help" style={{ marginBottom: 16 }}>{t('calendar.delete_irreversible')}</p>
            <div className="task-action-row">
              <button className="btn btn-secondary" onClick={() => setDeleteConfirmEventId(null)}>{t('common.cancel')}</button>
              <button className="btn btn-primary" onClick={() => handleDeleteEvent(deleteConfirmEventId)} style={{ background: 'var(--danger)' }}>
                {t('common.delete')}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title={t('calendar.title')}
        subtitle={currentDate.toLocaleDateString(locale, { year: 'numeric', month: 'long', day: view === 'day' ? 'numeric' : undefined })}
        icon={<CalendarDays size={19} />}
        actions={
          <>
            <button className="btn btn-secondary" onClick={() => setCurrentDate(new Date())}>{t('common.today')}</button>
            <button className="btn btn-secondary icon-button" onClick={() => setCurrentDate((date) => addDays(date, view === 'month' ? -30 : view === 'week' ? -7 : -1))} aria-label={t('calendar.nav_prev')}>
              <ChevronLeft size={16} />
            </button>
            <button className="btn btn-secondary icon-button" onClick={() => setCurrentDate((date) => addDays(date, view === 'month' ? 30 : view === 'week' ? 7 : 1))} aria-label={t('calendar.nav_next')}>
              <ChevronRight size={16} />
            </button>
            <button className="btn btn-primary" onClick={handleOpenCreateForm}>
              <Plus size={16} />
              {t('calendar.add_event')}
            </button>
            {view === 'day' && (
              <button className="btn btn-secondary" onClick={() => handleClearGeneratedSchedule(currentDate)} disabled={isLoading || getDayBlocks(currentDate).length === 0}>
                <Trash2 size={16} />
                {t('calendar.clear_auto_schedule')}
              </button>
            )}
          </>
        }
      />

      <div className="metric-grid">
        <MetricCard label={t('calendar.blocks_section')} value={blocks.length} hint={t('calendar.drag_hint')} />
        <MetricCard label={t('calendar.events_section')} value={visibleEventsCount} hint={t('calendar.add_event')} />
        <MetricCard label={t('tasks.pending')} value={pendingTasks} hint={t('calendar.task_label')} />
        <MetricCard label={t('calendar.conflict')} value={conflictCount} hint={conflictCount > 0 ? t('calendar.conflict') : t('analytics.status_good')} tone={conflictCount > 0 ? 'danger' : 'good'} />
        <MetricCard label={t('calendar.month_view')} value={visibleDays.length} hint={view === 'day' ? t('calendar.day_view') : view === 'week' ? t('calendar.week_view') : t('calendar.month_view')} />
      </div>

      {error && (
        <div className="card" role="alert" style={{ borderColor: 'var(--danger)', color: 'var(--danger-text)' }}>
          <AlertTriangle size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
          {error}
        </div>
      )}

      {renderEventCreateForm()}

      <SegmentedTabs<CalendarView>
        value={view}
        onChange={setView}
        ariaLabel={t('calendar.title')}
        items={[
          { value: 'day', label: t('calendar.day_view') },
          { value: 'week', label: t('calendar.week_view') },
          { value: 'month', label: t('calendar.month_view') },
        ]}
      />

      {isLoading ? (
        <Panel title={t('calendar.loading')} icon={<Clock3 size={17} />}>
          <EmptyPanel>
            <span className="loading-spinner" />
            {t('calendar.loading')}
          </EmptyPanel>
        </Panel>
      ) : view === 'day' ? (
        renderDayView()
      ) : view === 'week' ? (
        renderWeekView()
      ) : (
        renderMonthView()
      )}

      <EventEditModal
        isOpen={showEventEditModal}
        onClose={() => {
          setShowEventEditModal(false);
          setEditingEvent(null);
        }}
        onSaved={handleEventSaved}
        event={editingEvent}
      />
      {renderDeleteConfirm()}
    </PageShell>
  );
}
