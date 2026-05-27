import React, { useState, useEffect } from 'react';
import { callCapability } from '../lib/tauri';

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

export default function TasksPage() {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [filterStatus, setFilterStatus] = useState<string>('all');
  const [filterTag, setFilterTag] = useState<string>('all');
  const [filterProject, setFilterProject] = useState<string>('all');
  const [sortKey, setSortKey] = useState<SortKey>('created_at');
  const [viewMode, setViewMode] = useState<'list' | 'project' | 'tag'>('list');
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [boundEventsMap, setBoundEventsMap] = useState<Map<string, EventItem[]>>(new Map());

  useEffect(() => { loadTasks(); }, []);

  async function loadTasks() {
    try {
      const result = await callCapability('task.list', {}) as { success: boolean; data?: Task[] };
      if (result.success && result.data) setTasks(result.data);
    } catch (err) { console.error('Failed to load tasks:', err); }
  }

  async function addTask() {
    if (!newTitle.trim()) return;
    await callCapability('task.create', { title: newTitle });
    setNewTitle('');
    loadTasks();
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

  async function loadBoundEvents(taskId: string) {
    try {
      const result = await callCapability('event.list', {}) as { success: boolean; data?: EventItem[] };
      if (result.success && result.data) {
        setBoundEventsMap((prev) => {
          const next = new Map(prev);
          next.set(taskId, result.data!.filter((e) => e.bound_task_id === taskId));
          return next;
        });
      }
    } catch (err) {
      console.error('Failed to load bound events:', err);
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

  const allTags = Array.from(new Set(tasks.flatMap((t) => t.tags)));
  const allProjects = Array.from(new Set(tasks.map((t) => t.project).filter(Boolean))) as string[];

  let filtered = tasks;
  if (filterStatus !== 'all') filtered = filtered.filter((t) => t.status === filterStatus);
  if (filterTag !== 'all') filtered = filtered.filter((t) => t.tags.includes(filterTag));
  if (filterProject !== 'all') filtered = filtered.filter((t) => t.project === filterProject);

  const sorted = [...filtered].sort((a, b) => {
    if (sortKey === 'due_date') return (a.due_date || '').localeCompare(b.due_date || '');
    if (sortKey === 'title') return a.title.localeCompare(b.title);
    return b.created_at.localeCompare(a.created_at);
  });

  const groupedByProject: Record<string, Task[]> = {};
  const groupedByTag: Record<string, Task[]> = {};
  if (viewMode === 'project') {
    for (const t of sorted) {
      const p = t.project || '未分类';
      if (!groupedByProject[p]) groupedByProject[p] = [];
      groupedByProject[p].push(t);
    }
  }
  if (viewMode === 'tag') {
    for (const t of sorted) {
      if (t.tags.length === 0) {
        if (!groupedByTag['无标签']) groupedByTag['无标签'] = [];
        groupedByTag['无标签'].push(t);
      }
      for (const tag of t.tags) {
        if (!groupedByTag[tag]) groupedByTag[tag] = [];
        groupedByTag[tag].push(t);
      }
    }
  }

  const topLevelTasks = sorted.filter((t) => !t.parent_task_id);
  const subTasksMap = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.parent_task_id) {
      if (!subTasksMap.has(t.parent_task_id)) subTasksMap.set(t.parent_task_id, []);
      subTasksMap.get(t.parent_task_id)!.push(t);
    }
  }

  return (
    <div>
      <h1 className="page-title">任务</h1>
      <div className="quick-add">
        <input type="text" placeholder="新建任务..." value={newTitle} onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && addTask()} />
        <button className="btn btn-primary" onClick={addTask}>添加</button>
      </div>

      {/* Filters and View */}
      <div className="card" style={{ padding: 12 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>视图：</span>
          <button className={`btn ${viewMode === 'list' ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: 12, padding: '4px 12px' }} onClick={() => setViewMode('list')}>列表</button>
          <button className={`btn ${viewMode === 'project' ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: 12, padding: '4px 12px' }} onClick={() => setViewMode('project')}>项目</button>
          <button className={`btn ${viewMode === 'tag' ? 'btn-primary' : 'btn-secondary'}`} style={{ fontSize: 12, padding: '4px 12px' }} onClick={() => setViewMode('tag')}>标签</button>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 8, fontSize: 13 }}>
          <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ width: 'auto' }}>
            <option value="all">所有状态</option>
            <option value="pending">待办</option>
            <option value="completed">已完成</option>
            <option value="deferred">已延期</option>
          </select>
          <select value={filterTag} onChange={(e) => setFilterTag(e.target.value)} style={{ width: 'auto' }}>
            <option value="all">所有标签</option>
            {allTags.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
          </select>
          <select value={filterProject} onChange={(e) => setFilterProject(e.target.value)} style={{ width: 'auto' }}>
            <option value="all">所有项目</option>
            {allProjects.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
          <select value={sortKey} onChange={(e) => setSortKey(e.target.value as SortKey)} style={{ width: 'auto' }}>
            <option value="created_at">按创建时间</option>
            <option value="due_date">按截止时间</option>
            <option value="title">按标题</option>
          </select>
        </div>
      </div>

      {/* Project View */}
      {viewMode === 'project' && (
        <div>
          {Object.entries(groupedByProject).map(([project, projectTasks]) => (
            <div key={project} className="card">
              <h3 className="card-title">{project} ({projectTasks.length})</h3>
              {projectTasks.map((task) => (
                <div key={task.id} className={`task-item ${task.status === 'completed' ? 'completed' : ''}`}>
                  <span className="task-title">{task.title}</span>
                  <span style={{ fontSize: 12, color: '#888', marginRight: 8 }}>{task.due_date?.slice(0, 10) || ''}</span>
                  {task.locked && <span style={{ fontSize: 12, color: '#f59e0b', marginRight: 4 }}>🔒</span>}
                  {task.status !== 'completed' && (
                    <>
                      <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => completeTask(task.id)}>完成</button>
                      <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => deferTask(task.id)}>延期</button>
                    </>
                  )}
                  <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => lockTask(task.id, !task.locked)}>
                    {task.locked ? '解锁' : '锁定'}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* Tag View */}
      {viewMode === 'tag' && (
        <div>
          {Object.entries(groupedByTag).map(([tag, tagTasks]) => (
            <div key={tag} className="card">
              <h3 className="card-title">#{tag} ({tagTasks.length})</h3>
              {tagTasks.map((task) => (
                <div key={task.id} className={`task-item ${task.status === 'completed' ? 'completed' : ''}`}>
                  <span className="task-title">{task.title}</span>
                  <span style={{ fontSize: 12, color: '#888', marginRight: 8 }}>{task.project || ''}</span>
                  {task.locked && <span style={{ fontSize: 12, color: '#f59e0b', marginRight: 4 }}>🔒</span>}
                  {task.status !== 'completed' && (
                    <>
                      <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => completeTask(task.id)}>完成</button>
                      <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => deferTask(task.id)}>延期</button>
                    </>
                  )}
                  <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => lockTask(task.id, !task.locked)}>
                    {task.locked ? '解锁' : '锁定'}
                  </button>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {/* List View with Subtasks */}
      {viewMode === 'list' && (
        <div className="card">
          {topLevelTasks.map((task) => {
            const subs = subTasksMap.get(task.id) || [];
            const isExpanded = expandedTasks.has(task.id);

            return (
              <div key={task.id}>
                <div className={`task-item ${task.status === 'completed' ? 'completed' : ''}`}>
                  <span className="task-title">{task.title}</span>
                  <span style={{ fontSize: 12, color: '#888', marginRight: 8 }}>
                    {task.due_date?.slice(0, 10) || ''}
                    {task.project && ` [${task.project}]`}
                    {task.tags.map((t) => ` #${t}`)}
                  </span>
                  {task.locked && <span style={{ fontSize: 12, color: '#f59e0b', marginRight: 4 }}>🔒</span>}
                  {subs.length > 0 && (
                    <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px', marginRight: 4 }}
                      onClick={() => toggleExpand(task.id)}>
                      {isExpanded ? '收起子任务' : `子任务(${subs.length})`}
                    </button>
                  )}
                  {task.status !== 'completed' && (
                    <>
                      <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => completeTask(task.id)}>完成</button>
                      <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => deferTask(task.id)}>延期</button>
                    </>
                  )}
                  <button className="btn btn-secondary" style={{ fontSize: 11, padding: '2px 8px' }} onClick={() => lockTask(task.id, !task.locked)}>
                    {task.locked ? '解锁' : '锁定'}
                  </button>
                </div>
                {isExpanded && subs.length > 0 && (
                  <div style={{ marginLeft: 24 }}>
                    {subs.map((sub) => (
                      <div key={sub.id} className="task-item" style={{ borderLeftColor: '#94a3b8' }}>
                        <span className="task-title" style={{ fontSize: 13 }}>↳ {sub.title}</span>
                        <span style={{ fontSize: 11, color: '#888', marginRight: 8 }}>{sub.due_date?.slice(0, 10) || ''}</span>
                        {sub.locked && <span style={{ fontSize: 12, color: '#f59e0b' }}>🔒</span>}
                      </div>
                    ))}
                  </div>
                )}
                {isExpanded && boundEventsMap.get(task.id) && boundEventsMap.get(task.id)!.length > 0 && (
                  <div style={{ marginLeft: 24, fontSize: 12, color: '#3b82f6', padding: '4px 0' }}>
                    📅 绑定事件：{boundEventsMap.get(task.id)!.map((e) => e.title).join(', ')}
                  </div>
                )}
              </div>
            );
          })}
          {sorted.length === 0 && <p style={{ color: '#888', fontSize: 14, textAlign: 'center', padding: 20 }}>暂无任务</p>}
        </div>
      )}
    </div>
  );
}