import React, { useEffect, useMemo, useState } from 'react';
import {
  CalendarDays,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Edit3,
  FolderKanban,
  ListChecks,
  Lock,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Tags,
  Trash2,
  Unlock,
  X,
} from 'lucide-react';
import { callCapability } from '../lib/tauri';
import { useI18n } from '../lib/i18n';
import TaskEditModal from '../components/TaskEditModal';
import { EmptyPanel, MetricCard, PageHeader, PageShell, Panel, SegmentedTabs } from '../components/PageChrome';

interface Task {
  id: string;
  title: string;
  description: string;
  status: string;
  project: string | null;
  tags: string[];
  due_date: string | null;
  duration_minutes: number | null;
  locked: boolean;
  parent_task_id: string | null;
  time_effect_type: string;
  created_at: string;
}

interface EventItem {
  id: string;
  title: string;
  bound_task_id: string | null;
  start_time: string;
}

type SortKey = 'due_date' | 'created_at' | 'title';
type ViewMode = 'list' | 'project' | 'tag';

const PAGE_SIZE = 100;

function dateLabel(value: string | null) {
  if (!value) {return '';}
  return value.includes('T') ? `${value.slice(0, 10)} ${value.slice(11, 16)}` : value.slice(0, 10);
}

function durationLabel(minutes: number | null) {
  if (!minutes) {return '';}
  return minutes >= 60 ? `${(minutes / 60).toFixed(1)}h` : `${minutes}min`;
}

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterTag, setFilterTag] = useState<string>('all');
  const [filterProject, setFilterProject] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [viewMode, setViewMode] = useState<ViewMode>('list');
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [boundEventsMap, setBoundEventsMap] = useState<Map<string, EventItem[]>>(new Map());
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [displayCount, setDisplayCount] = useState(PAGE_SIZE);
  const [editingTask, setEditingTask] = useState<string | null>(null);
  const [taskModalOpen, setTaskModalOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editDueDate, setEditDueDate] = useState('');
  const [editProject, setEditProject] = useState('');
  const { t } = useI18n();

  useEffect(() => {
    loadTasks();
  }, []);

  async function loadTasks() {
    setIsLoading(true);
    setError(null);
    try {
      const result = await callCapability('task.list', {}) as { success: boolean; data?: Task[] };
      if (result.success && result.data) {
        setTasks(result.data);
      } else {
        setError(t('tasks.load_error'));
      }
    } catch (err) {
      console.error('Failed to load tasks:', err);
      const message = err instanceof Error ? err.message : String(err);
      setError(message.includes('invoke') ? null : `${t('tasks.load_error')}: ${message}`);
    } finally {
      setIsLoading(false);
    }
  }

  async function addTask() {
    if (!newTitle.trim()) {return;}
    const title = newTitle.trim();
    setNewTitle('');
    try {
      await callCapability('task.create', { title });
      loadTasks();
    } catch (err) {
      setNewTitle(title);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function completeTask(id: string) {
    await callCapability('task.complete', { task_id: id });
    loadTasks();
  }

  async function deferTask(id: string) {
    await callCapability('task.defer', { task_id: id });
    loadTasks();
  }

  async function lockTask(id: string, locked: boolean) {
    await callCapability('task.lock', { task_id: id, locked });
    loadTasks();
  }

  async function deleteTask(id: string) {
    if (!window.confirm(t('tasks.confirm_delete'))) {return;}
    await callCapability('task.delete', { task_id: id });
    loadTasks();
  }

  async function cancelTask(id: string) {
    await callCapability('task.cancel', { task_id: id });
    loadTasks();
  }

  function startEditing(task: Task) {
    setEditingTask(task.id);
    setEditTitle(task.title);
    setEditDueDate(task.due_date?.slice(0, 10) || '');
    setEditProject(task.project || '');
  }

  function cancelEditing() {
    setEditingTask(null);
    setEditTitle('');
    setEditDueDate('');
    setEditProject('');
  }

  async function saveEditing(taskId: string) {
    if (!editTitle.trim()) {return;}
    const params: Record<string, unknown> = { task_id: taskId, title: editTitle.trim() };
    if (editDueDate) {params.due_date = editDueDate;}
    if (editProject) {params.project = editProject;}
    await callCapability('task.update', params);
    cancelEditing();
    loadTasks();
  }

  async function loadBoundEvents(taskId: string) {
    try {
      const result = await callCapability('event.list', {}) as { success: boolean; data?: EventItem[] };
      if (result.success && result.data) {
        setBoundEventsMap((prev) => {
          const next = new Map(prev);
          next.set(taskId, result.data!.filter((event) => event.bound_task_id === taskId));
          return next;
        });
      }
    } catch {
      // Bound events are helpful context, not a blocking failure for task management.
    }
  }

  function toggleExpand(taskId: string) {
    const next = new Set(expandedTasks);
    if (next.has(taskId)) {
      next.delete(taskId);
    } else {
      next.add(taskId);
      loadBoundEvents(taskId);
    }
    setExpandedTasks(next);
  }

  const allTags = useMemo(() => Array.from(new Set(tasks.flatMap((task) => task.tags))), [tasks]);

  const allProjects = useMemo(
    () => Array.from(new Set(tasks.map((task) => task.project).filter(Boolean))) as string[],
    [tasks],
  );

  const filtered = useMemo(() => {
    let result = tasks;
    if (filterStatus !== 'all') {result = result.filter((task) => task.status === filterStatus);}
    if (filterTag !== 'all') {result = result.filter((task) => task.tags.includes(filterTag));}
    if (filterProject !== 'all') {result = result.filter((task) => task.project === filterProject);}
    return result;
  }, [tasks, filterStatus, filterTag, filterProject]);

  const sorted = useMemo(
    () =>
      [...filtered].sort((a, b) => {
        if (sortKey === 'due_date') {return (a.due_date || '').localeCompare(b.due_date || '');}
        if (sortKey === 'title') {return a.title.localeCompare(b.title);}
        return b.created_at.localeCompare(a.created_at);
      }),
    [filtered, sortKey],
  );

  const groupedByProject = useMemo(() => {
    const groups: Record<string, Task[]> = {};
    for (const task of sorted) {
      const project = task.project || '__uncategorized__';
      if (!groups[project]) {groups[project] = [];}
      groups[project].push(task);
    }
    return groups;
  }, [sorted]);

  const groupedByTag = useMemo(() => {
    const groups: Record<string, Task[]> = {};
    for (const task of sorted) {
      if (task.tags.length === 0) {
        if (!groups.__no_tag__) {groups.__no_tag__ = [];}
        groups.__no_tag__.push(task);
      }
      for (const tag of task.tags) {
        if (!groups[tag]) {groups[tag] = [];}
        groups[tag].push(task);
      }
    }
    return groups;
  }, [sorted]);

  const subTasksMap = useMemo(() => {
    const map = new Map<string, Task[]>();
    for (const task of tasks) {
      if (task.parent_task_id) {
        if (!map.has(task.parent_task_id)) {map.set(task.parent_task_id, []);}
        map.get(task.parent_task_id)!.push(task);
      }
    }
    return map;
  }, [tasks]);

  const topLevelTasks = useMemo(() => sorted.filter((task) => !task.parent_task_id), [sorted]);
  const displayedTasks = useMemo(() => topLevelTasks.slice(0, displayCount), [topLevelTasks, displayCount]);
  const hasMore = displayCount < topLevelTasks.length;
  const pendingCount = tasks.filter((task) => task.status === 'pending').length;
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const deferredCount = tasks.filter((task) => task.status === 'deferred').length;
  const lockedCount = tasks.filter((task) => task.locked).length;

  function statusLabel(status: string) {
    if (status === 'pending') {return t('tasks.pending');}
    if (status === 'completed') {return t('tasks.completed');}
    if (status === 'deferred') {return t('tasks.deferred');}
    return status;
  }

  function renderTaskRow(task: Task, nested = false) {
    const subs = subTasksMap.get(task.id) || [];
    const isExpanded = expandedTasks.has(task.id);
    const isEditing = editingTask === task.id;
    const boundEvents = boundEventsMap.get(task.id) || [];

    return (
      <React.Fragment key={task.id}>
        <div className="task-row-modern" style={nested ? { marginLeft: 28 } : undefined}>
          <button
            className={`task-check ${task.status === 'completed' ? 'done' : ''}`}
            onClick={() => task.status !== 'completed' && completeTask(task.id)}
            aria-label={t('tasks.aria_complete', { title: task.title })}
          >
            {task.status === 'completed' && <Check size={13} />}
          </button>

          {isEditing ? (
            <div className="field-grid" style={{ gridColumn: '2 / -1' }}>
              <label className="field-row">
                {t('tasks.task_title_placeholder')}
                <input
                  type="text"
                  value={editTitle}
                  onChange={(event) => setEditTitle(event.target.value)}
                  autoFocus
                />
              </label>
              <label className="field-row">
                {t('tasks.due_date_label')}
                <input type="date" value={editDueDate} onChange={(event) => setEditDueDate(event.target.value)} />
              </label>
              <label className="field-row">
                {t('tasks.project_label')}
                <input
                  type="text"
                  value={editProject}
                  onChange={(event) => setEditProject(event.target.value)}
                  placeholder={t('tasks.project_name_placeholder')}
                />
              </label>
              <div className="task-action-row" style={{ alignSelf: 'end' }}>
                <button className="btn btn-primary" onClick={() => saveEditing(task.id)}>
                  <Check size={15} />
                  {t('common.save')}
                </button>
                <button className="btn btn-secondary" onClick={cancelEditing}>
                  <X size={15} />
                  {t('common.cancel')}
                </button>
              </div>
            </div>
          ) : (
            <>
              <div>
                <div className="task-main-title">{nested ? `↳ ${task.title}` : task.title}</div>
                <div className="task-main-meta">
                  <span className={`pill ${task.status === 'completed' ? 'success' : task.status === 'deferred' ? 'warning' : ''}`}>
                    {statusLabel(task.status)}
                  </span>
                  {task.project && (
                    <span className="pill">
                      <FolderKanban size={12} />
                      {task.project}
                    </span>
                  )}
                  {task.due_date && (
                    <span>
                      <CalendarDays size={12} style={{ verticalAlign: '-2px' }} /> {dateLabel(task.due_date)}
                    </span>
                  )}
                  {task.duration_minutes && (
                    <span>
                      <Clock3 size={12} style={{ verticalAlign: '-2px' }} /> {durationLabel(task.duration_minutes)}
                    </span>
                  )}
                  {task.tags.map((tag) => (
                    <span key={tag} className="pill">
                      <Tags size={12} />
                      {tag}
                    </span>
                  ))}
                  {boundEvents.length > 0 && <span>{t('tasks.bound_events')}：{boundEvents.map((event) => event.title).join(', ')}</span>}
                </div>
              </div>
              <div className="task-action-row">
                {subs.length > 0 && (
                  <button className="btn btn-secondary icon-button" onClick={() => toggleExpand(task.id)} aria-label={isExpanded ? t('tasks.aria_collapse_subtasks') : t('tasks.aria_expand_subtasks', { count: subs.length })}>
                    {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                )}
                {task.status !== 'completed' && (
                  <>
                    <button className="btn btn-secondary icon-button" onClick={() => deferTask(task.id)} aria-label={t('tasks.aria_defer', { title: task.title })}>
                      <Clock3 size={16} />
                    </button>
                    <button className="btn btn-secondary icon-button" onClick={() => cancelTask(task.id)} aria-label={t('tasks.aria_cancel', { title: task.title })}>
                      <X size={16} />
                    </button>
                  </>
                )}
                <button className="btn btn-secondary icon-button" onClick={() => lockTask(task.id, !task.locked)} aria-label={task.locked ? t('tasks.aria_unlock', { title: task.title }) : t('tasks.aria_lock', { title: task.title })}>
                  {task.locked ? <Lock size={16} /> : <Unlock size={16} />}
                </button>
                <button className="btn btn-secondary icon-button" onClick={() => startEditing(task)} aria-label={t('tasks.aria_edit', { title: task.title })}>
                  <Edit3 size={16} />
                </button>
                <button className="btn btn-secondary icon-button" onClick={() => deleteTask(task.id)} aria-label={t('tasks.aria_delete', { title: task.title })} style={{ color: 'var(--danger-text)' }}>
                  <Trash2 size={16} />
                </button>
              </div>
            </>
          )}
        </div>
        {isExpanded && subs.map((sub) => renderTaskRow(sub, true))}
      </React.Fragment>
    );
  }

  function renderTaskCollection(list: Task[], emptyText: string) {
    if (list.length === 0) {return <EmptyPanel>{emptyText}</EmptyPanel>;}
    return (
      <div className="task-list" role="list" aria-label={t('tasks.aria_task_list')}>
        {list.map((task) => renderTaskRow(task))}
      </div>
    );
  }

  const pageActions = (
    <>
      <button className="btn btn-secondary" onClick={loadTasks} disabled={isLoading}>
        <RefreshCw size={16} />
        {t('common.retry')}
      </button>
      <button className="btn btn-primary" onClick={() => setTaskModalOpen(true)}>
        <Plus size={16} />
        {t('tasks.detailed_create')}
      </button>
    </>
  );

  return (
    <PageShell>
      <PageHeader
        title={t('tasks.title')}
        subtitle={t('tasks.count', { count: tasks.length })}
        icon={<ListChecks size={19} />}
        actions={pageActions}
      />

      <div className="metric-grid">
        <MetricCard label={t('analytics.total_tasks')} value={tasks.length} hint={`${pendingCount} ${t('tasks.pending')}`} />
        <MetricCard label={t('tasks.pending')} value={pendingCount} hint={t('tasks.view_list')} />
        <MetricCard label={t('tasks.completed')} value={completedCount} hint={`${tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0}%`} tone="good" />
        <MetricCard label={t('tasks.deferred')} value={deferredCount} hint={t('tasks.defer')} tone={deferredCount > 0 ? 'warn' : undefined} />
        <MetricCard label={t('tasks.lock')} value={lockedCount} hint={t('tasks.aria_locked')} />
      </div>

      <div className="quick-command">
        <input
          type="text"
          placeholder={t('tasks.new_task')}
          value={newTitle}
          onChange={(event) => setNewTitle(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && addTask()}
          aria-label={t('tasks.aria_new_task')}
        />
        <button className="btn btn-primary" onClick={addTask}>
          <Plus size={16} />
          {t('tasks.add')}
        </button>
        <button className="btn btn-secondary" onClick={() => setTaskModalOpen(true)}>
          <Edit3 size={16} />
          {t('tasks.detailed_create')}
        </button>
      </div>

      {error && (
        <div className="card" role="alert" style={{ borderColor: 'var(--danger)', color: 'var(--danger-text)' }}>
          {error}
        </div>
      )}

      <Panel title={t('tasks.view_toolbar')} icon={<SlidersHorizontal size={17} />}>
        <div className="field-grid">
          <label className="field-row">
            {t('tasks.view_label')}
            <SegmentedTabs<ViewMode>
              value={viewMode}
              onChange={setViewMode}
              ariaLabel={t('tasks.view_toolbar')}
              items={[
                { value: 'list', label: t('tasks.view_list') },
                { value: 'project', label: t('tasks.view_project') },
                { value: 'tag', label: t('tasks.view_tag') },
              ]}
            />
          </label>
          <label className="field-row">
            {t('tasks.all_status')}
            <select value={filterStatus} onChange={(event) => setFilterStatus(event.target.value)}>
              <option value="all">{t('tasks.all_status')}</option>
              <option value="pending">{t('tasks.pending')}</option>
              <option value="completed">{t('tasks.completed')}</option>
              <option value="deferred">{t('tasks.deferred')}</option>
            </select>
          </label>
          <label className="field-row">
            {t('tasks.all_tags')}
            <select value={filterTag} onChange={(event) => setFilterTag(event.target.value)}>
              <option value="all">{t('tasks.all_tags')}</option>
              {allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
            </select>
          </label>
          <label className="field-row">
            {t('tasks.all_projects')}
            <select value={filterProject} onChange={(event) => setFilterProject(event.target.value)}>
              <option value="all">{t('tasks.all_projects')}</option>
              {allProjects.map((project) => <option key={project} value={project}>{project}</option>)}
            </select>
          </label>
          <label className="field-row">
            {t('tasks.sort_created')}
            <select value={sortKey} onChange={(event) => setSortKey(event.target.value as SortKey)}>
              <option value="created_at">{t('tasks.sort_created')}</option>
              <option value="due_date">{t('tasks.sort_due')}</option>
              <option value="title">{t('tasks.sort_title')}</option>
            </select>
          </label>
        </div>
      </Panel>

      <Panel
        title={viewMode === 'list' ? t('tasks.view_list') : viewMode === 'project' ? t('tasks.view_project') : t('tasks.view_tag')}
        meta={isLoading ? t('common.loading') : `${sorted.length} / ${tasks.length}`}
        icon={<ListChecks size={17} />}
      >
        {isLoading ? (
          <EmptyPanel>
            <span className="loading-spinner" />
            {t('common.loading')}
          </EmptyPanel>
        ) : sorted.length === 0 ? (
          <EmptyPanel action={<button className="btn btn-primary" onClick={() => setTaskModalOpen(true)}><Plus size={16} />{t('tasks.detailed_create')}</button>}>
            {tasks.length === 0 ? t('tasks.no_tasks_yet') : t('tasks.no_filter_match')}
          </EmptyPanel>
        ) : viewMode === 'list' ? (
          <>
            {renderTaskCollection(displayedTasks, t('tasks.no_filter_match'))}
            {hasMore && (
              <div style={{ textAlign: 'center', paddingTop: 14 }}>
                <button className="btn btn-secondary" onClick={() => setDisplayCount((prev) => prev + PAGE_SIZE)}>
                  {t('tasks.load_more')} ({t('tasks.items_remaining', { count: topLevelTasks.length - displayCount })})
                </button>
              </div>
            )}
          </>
        ) : viewMode === 'project' ? (
          <div className="task-group-stack">
            {Object.entries(groupedByProject).map(([project, projectTasks]) => (
              <div className="group-panel" key={project}>
                <div className="group-panel-header">
                  <span className="group-panel-title">
                    <FolderKanban size={16} />
                    {project === '__uncategorized__' ? t('tasks.uncategorized') : project}
                  </span>
                  <span className="panel-meta">{projectTasks.length}</span>
                </div>
                {renderTaskCollection(projectTasks, t('tasks.no_filter_match'))}
              </div>
            ))}
          </div>
        ) : (
          <div className="task-group-stack">
            {Object.entries(groupedByTag).map(([tag, tagTasks]) => (
              <div className="group-panel" key={tag}>
                <div className="group-panel-header">
                  <span className="group-panel-title">
                    <Tags size={16} />
                    #{tag === '__no_tag__' ? t('tasks.no_tag') : tag}
                  </span>
                  <span className="panel-meta">{tagTasks.length}</span>
                </div>
                {renderTaskCollection(tagTasks, t('tasks.no_filter_match'))}
              </div>
            ))}
          </div>
        )}
      </Panel>

      <TaskEditModal
        isOpen={taskModalOpen}
        onClose={() => setTaskModalOpen(false)}
        onSaved={loadTasks}
        task={null}
        existingProjects={allProjects}
        existingTasks={tasks}
      />
    </PageShell>
  );
}
