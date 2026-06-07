import React, { useEffect, useMemo, useState } from 'react';
import {
  BarChart3,
  Brain,
  BriefcaseBusiness,
  Clock3,
  ListChecks,
  RefreshCw,
  Sparkles,
  Target,
  TrendingUp,
} from 'lucide-react';
import { callCapability } from '../lib/tauri';
import DreamInsightsPanel from '../components/DreamInsightsPanel';
import { useI18n } from '../lib/i18n';
import { EmptyPanel, MetricCard, PageHeader, PageShell, Panel, SegmentedTabs } from '../components/PageChrome';

interface TaskRecord {
  id: string;
  title: string;
  status: string;
  project: string | null;
  tags: string[];
  due_date: string | null;
  duration_minutes: number | null;
  created_at: string;
  updated_at?: string;
  completed_at?: string;
  time_effect_type: string;
}

interface DailyStats {
  date: string;
  completed: number;
  total: number;
  rate: number;
}

interface ProjectStat {
  name: string;
  count: number;
  completed: number;
  rate: number;
}

interface HourlyProductivity {
  hour: number;
  completed: number;
  total: number;
}

interface DreamInsight {
  id: string;
  category: string;
  insight_text: string;
  confidence: number;
  supporting_data: string | null;
  created_at: string;
}

type AnalyticsTab = 'overview' | 'projects' | 'productivity' | 'dream';

const HIGH_THRESHOLD = 80;
const MEDIUM_THRESHOLD = 50;

function getWeekDates(): string[] {
  const dates: string[] = [];
  for (let i = 6; i >= 0; i--) {
    const date = new Date();
    date.setDate(date.getDate() - i);
    dates.push(date.toISOString().split('T')[0]);
  }
  return dates;
}

function efficiencyTone(rate: number): 'good' | 'warn' | 'danger' {
  if (rate >= HIGH_THRESHOLD) {return 'good';}
  if (rate >= MEDIUM_THRESHOLD) {return 'warn';}
  return 'danger';
}

function efficiencyColor(rate: number): string {
  if (rate >= HIGH_THRESHOLD) {return 'var(--success)';}
  if (rate >= MEDIUM_THRESHOLD) {return 'var(--warning)';}
  return 'var(--danger)';
}

export default function AnalyticsPage() {
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<AnalyticsTab>('overview');
  const [dreamInsights, setDreamInsights] = useState<DreamInsight[]>([]);
  const [dreamInsightsLoading, setDreamInsightsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const { t } = useI18n();

  useEffect(() => {
    loadData();
    loadDreamInsights();
  }, []);

  async function loadData() {
    setIsLoading(true);
    try {
      const result = await callCapability('task.list', {}) as {
        success: boolean;
        data?: TaskRecord[];
      };
      if (result.success && result.data) {setTasks(result.data);}
    } catch {
      setTasks([]);
    } finally {
      setIsLoading(false);
    }
  }

  async function loadDreamInsights() {
    setDreamInsightsLoading(true);
    try {
      const result = await callCapability('dream.get_insights', { limit: 5 }) as {
        success: boolean;
        data?: DreamInsight[];
      };
      setDreamInsights(result.success && result.data ? result.data : []);
    } catch {
      setDreamInsights([]);
    } finally {
      setDreamInsightsLoading(false);
    }
  }

  async function handleRefresh() {
    setIsRefreshing(true);
    try {
      await callCapability('dream.run', {});
    } catch {
      // The panel remains useful with the latest persisted insight set.
    } finally {
      setIsRefreshing(false);
      loadDreamInsights();
    }
  }

  const weekDates = useMemo(() => getWeekDates(), []);

  const weeklyStats: DailyStats[] = useMemo(() => {
    return weekDates.map((date) => {
      const dayTasks = tasks.filter((task) => {
        const created = task.created_at?.startsWith(date);
        const updated = task.updated_at?.startsWith(date);
        const due = task.due_date?.startsWith(date);
        const completed = task.completed_at?.startsWith(date);
        return created || updated || due || completed;
      });
      const completed = tasks.filter((task) => task.status === 'completed' && task.completed_at?.startsWith(date));
      const total = dayTasks.length;
      return {
        date,
        completed: completed.length,
        total,
        rate: total > 0 ? Math.round((completed.length / total) * 100) : 0,
      };
    });
  }, [tasks, weekDates]);

  const projectStats: ProjectStat[] = useMemo(() => {
    const projectMap = new Map<string, { count: number; completed: number }>();
    for (const task of tasks) {
      const project = task.project || t('tasks.uncategorized');
      const entry = projectMap.get(project) || { count: 0, completed: 0 };
      entry.count++;
      if (task.status === 'completed') {entry.completed++;}
      projectMap.set(project, entry);
    }
    return Array.from(projectMap.entries())
      .map(([name, stats]) => ({
        name,
        count: stats.count,
        completed: stats.completed,
        rate: stats.count > 0 ? Math.round((stats.completed / stats.count) * 100) : 0,
      }))
      .sort((a, b) => b.count - a.count);
  }, [tasks, t]);

  const hourlyProductivity: HourlyProductivity[] = useMemo(() => {
    const hourMap = new Map<number, { completed: number; total: number }>();
    for (let hour = 6; hour <= 23; hour++) {hourMap.set(hour, { completed: 0, total: 0 });}

    for (const task of tasks) {
      if (task.status === 'completed' && task.completed_at) {
        const hour = parseInt(task.completed_at.slice(11, 13), 10);
        if (!Number.isNaN(hour) && hourMap.has(hour)) {
          const entry = hourMap.get(hour)!;
          entry.completed++;
          entry.total++;
        }
      }
      if (task.updated_at) {
        const hour = parseInt(task.updated_at.slice(11, 13), 10);
        if (!Number.isNaN(hour) && hourMap.has(hour)) {
          hourMap.get(hour)!.total++;
        }
      }
    }

    return Array.from(hourMap.entries())
      .map(([hour, stats]) => ({ hour, completed: stats.completed, total: stats.total }))
      .filter((hour) => hour.total > 0);
  }, [tasks]);

  const averageDailyCompletion = useMemo(() => {
    if (tasks.length === 0) {return 0;}
    const completedTasks = tasks.filter((task) => task.status === 'completed');
    const activeDays = new Set<string>();
    for (const task of tasks) {
      if (task.created_at) {activeDays.add(task.created_at.slice(0, 10));}
      if (task.completed_at) {activeDays.add(task.completed_at.slice(0, 10));}
    }
    return activeDays.size > 0 ? Math.round((completedTasks.length / activeDays.size) * 10) / 10 : 0;
  }, [tasks]);

  const mostProductiveHour = useMemo(() => {
    if (hourlyProductivity.length === 0) {return null;}
    return hourlyProductivity.reduce((best, current) => (current.completed > best.completed ? current : best));
  }, [hourlyProductivity]);

  const scheduleAdherence = useMemo(() => {
    if (tasks.length === 0) {return { rate: 0, completed: 0, total: 0 };}
    const completed = tasks.filter((task) => task.status === 'completed').length;
    const deferred = tasks.filter((task) => task.status === 'deferred').length;
    const totalActive = completed + deferred;
    return {
      rate: totalActive > 0 ? Math.round((completed / totalActive) * 100) : 0,
      completed,
      total: totalActive,
    };
  }, [tasks]);

  const weekdays = useMemo(() => t('analytics.weekdays').split(','), [t]);
  const maxWeeklyRate = useMemo(() => Math.max(...weeklyStats.map((stat) => stat.rate), 1), [weeklyStats]);
  const maxWeeklyCompleted = useMemo(() => Math.max(...weeklyStats.map((stat) => stat.completed), 1), [weeklyStats]);
  const maxProjectCount = useMemo(() => Math.max(...projectStats.map((project) => project.count), 1), [projectStats]);
  const maxHourly = useMemo(() => Math.max(...hourlyProductivity.map((hour) => hour.total), 1), [hourlyProductivity]);
  const completedCount = tasks.filter((task) => task.status === 'completed').length;
  const pendingCount = tasks.filter((task) => task.status === 'pending').length;

  function renderOverview() {
    if (tasks.length === 0) {
      return (
        <Panel title={t('analytics.overview')} icon={<BarChart3 size={17} />}>
          <EmptyPanel>{t('analytics.no_data')}<br />{t('analytics.no_data_hint')}</EmptyPanel>
        </Panel>
      );
    }

    return (
      <div className="section-grid">
        <Panel title={t('analytics.weekly_rate')} icon={<TrendingUp size={17} />} className="chart-card">
          <div className="bar-chart">
            {weeklyStats.map((day) => (
              <div className="bar-column" key={day.date}>
                <span className="bar-column-value" style={{ color: efficiencyColor(day.rate) }}>{day.rate}%</span>
                <div
                  className="bar-column-fill"
                  style={{
                    height: `${Math.max((day.rate / maxWeeklyRate) * 150, 4)}px`,
                    background: efficiencyColor(day.rate),
                  }}
                  title={t('analytics.weekly_rate_tooltip', { date: day.date, completed: day.completed, total: day.total, rate: day.rate })}
                />
                <span className="bar-column-label">{weekdays[new Date(day.date).getDay()]}</span>
                <span className="field-help">{day.completed}/{day.total}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title={t('analytics.daily_trend')} icon={<BarChart3 size={17} />} className="chart-card">
          <div className="bar-chart">
            {weeklyStats.map((day) => (
              <div className="bar-column" key={day.date}>
                <span className="bar-column-value">{day.completed}</span>
                <div
                  className="bar-column-fill"
                  style={{ height: `${Math.max((day.completed / maxWeeklyCompleted) * 130, 4)}px` }}
                />
                <span className="bar-column-label">{weekdays[new Date(day.date).getDay()]}</span>
              </div>
            ))}
          </div>
        </Panel>

        <Panel title={t('analytics.schedule_rate')} icon={<Target size={17} />}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
            <div
              style={{
                width: 92,
                height: 92,
                borderRadius: '50%',
                background: `conic-gradient(${efficiencyColor(scheduleAdherence.rate)} ${scheduleAdherence.rate * 3.6}deg, #eef2f7 ${scheduleAdherence.rate * 3.6}deg)`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <div style={{ width: 66, height: 66, borderRadius: '50%', background: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20, fontWeight: 800, color: efficiencyColor(scheduleAdherence.rate) }}>
                {scheduleAdherence.rate}%
              </div>
            </div>
            <div>
              <div className="task-main-title">{t('analytics.schedule_detail', { completed: scheduleAdherence.completed, total: scheduleAdherence.total })}</div>
              <div className="field-help" style={{ marginTop: 6 }}>{t('analytics.schedule_hint')}</div>
            </div>
          </div>
        </Panel>

        {mostProductiveHour && (
          <Panel title={t('analytics.best_hour_title')} icon={<Clock3 size={17} />}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
              <div className="metric-value metric-good">{String(mostProductiveHour.hour).padStart(2, '0')}:00</div>
              <div>
                <div className="task-main-title">{t('analytics.best_hour_detail', { count: mostProductiveHour.completed })}</div>
                <div className="field-help" style={{ marginTop: 6 }}>{t('analytics.best_hour_hint')}</div>
              </div>
            </div>
          </Panel>
        )}
      </div>
    );
  }

  function renderProjects() {
    return (
      <div className="section-grid single">
        <Panel title={t('analytics.project_distribution')} icon={<BriefcaseBusiness size={17} />}>
          {projectStats.length === 0 ? (
            <EmptyPanel>{t('analytics.no_project_data')}</EmptyPanel>
          ) : (
            <div className="task-group-stack">
              {projectStats.map((project) => (
                <div key={project.name}>
                  <div className="task-row-modern" style={{ gridTemplateColumns: '1fr auto', minHeight: 40, padding: '4px 0' }}>
                    <div>
                      <div className="task-main-title">{project.name}</div>
                      <div className="task-main-meta">{project.completed}/{project.count} · {project.rate}%</div>
                    </div>
                    <span className={`status-badge ${efficiencyTone(project.rate)}`}>{project.rate >= HIGH_THRESHOLD ? t('analytics.status_good') : project.rate >= MEDIUM_THRESHOLD ? t('analytics.status_in_progress') : t('analytics.status_needs_attention')}</span>
                  </div>
                  <div className="bar-track">
                    <div className="bar-fill" style={{ width: `${(project.count / maxProjectCount) * 100}%`, opacity: 0.16 }} />
                    <div className="bar-fill success" style={{ width: `${(project.completed / project.count) * 100}%`, position: 'absolute', left: 0, top: 0 }} />
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title={t('analytics.project_detail_title')} icon={<ListChecks size={17} />}>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>{t('analytics.column_project')}</th>
                  <th>{t('analytics.column_total')}</th>
                  <th>{t('analytics.column_completed')}</th>
                  <th>{t('analytics.column_rate')}</th>
                  <th>{t('analytics.column_status')}</th>
                </tr>
              </thead>
              <tbody>
                {projectStats.map((project) => (
                  <tr key={project.name}>
                    <td>{project.name}</td>
                    <td>{project.count}</td>
                    <td>{project.completed}</td>
                    <td><strong style={{ color: efficiencyColor(project.rate) }}>{project.rate}%</strong></td>
                    <td>
                      <span className={`status-badge ${efficiencyTone(project.rate)}`}>
                        {project.rate >= HIGH_THRESHOLD ? t('analytics.status_good') : project.rate >= MEDIUM_THRESHOLD ? t('analytics.status_in_progress') : t('analytics.status_needs_attention')}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      </div>
    );
  }

  function renderProductivity() {
    return (
      <div className="section-grid">
        <Panel title={t('analytics.hourly_title')} icon={<Clock3 size={17} />} meta={t('analytics.hourly_hint')}>
          {hourlyProductivity.length === 0 ? (
            <EmptyPanel>{t('analytics.no_hourly_data')}</EmptyPanel>
          ) : (
            <div className="task-group-stack">
              {Array.from({ length: 18 }, (_, index) => index + 6).map((hour) => {
                const stat = hourlyProductivity.find((item) => item.hour === hour);
                const total = stat?.total || 0;
                const completed = stat?.completed || 0;
                return (
                  <div key={hour} style={{ display: 'grid', gridTemplateColumns: '52px 1fr 56px', alignItems: 'center', gap: 10 }}>
                    <span className="field-help" style={{ textAlign: 'right' }}>{String(hour).padStart(2, '0')}:00</span>
                    <div className="bar-track">
                      <div className="bar-fill" style={{ width: `${total > 0 ? (total / maxHourly) * 100 : 0}%`, opacity: 0.18 }} />
                      {total > 0 && (
                        <div className="bar-fill success" style={{ width: `${(completed / Math.max(total, 1)) * (total / maxHourly) * 100}%`, position: 'absolute', left: 0, top: 0 }} />
                      )}
                    </div>
                    <span className="field-help">{total > 0 ? `${completed}/${total}` : '-'}</span>
                  </div>
                );
              })}
            </div>
          )}
        </Panel>

        <Panel
          title={t('analytics.insight_title')}
          icon={<Brain size={17} />}
          actions={
            <button className="btn btn-primary" onClick={handleRefresh} disabled={isRefreshing || dreamInsightsLoading}>
              <RefreshCw size={15} />
              {isRefreshing ? t('analytics.buttons.refreshing') : t('analytics.buttons.refresh')}
            </button>
          }
        >
          {dreamInsightsLoading ? (
            <EmptyPanel>
              <span className="loading-spinner" />
              {t('dream.loading')}
            </EmptyPanel>
          ) : dreamInsights.length === 0 ? (
            <EmptyPanel>{t('analytics.empty.dream_hint')}</EmptyPanel>
          ) : (
            <div className="task-group-stack">
              {dreamInsights.slice(0, 5).map((insight) => (
                <div className="assistant-message" key={insight.id}>
                  <span className="status-badge good" style={{ marginBottom: 8 }}>
                    <Sparkles size={13} />
                    {Math.round(insight.confidence * 100)}%
                  </span>
                  <div>{insight.insight_text}</div>
                </div>
              ))}
              <div className="field-help">{t('analytics.dream_footer')}</div>
            </div>
          )}
        </Panel>
      </div>
    );
  }

  if (isLoading) {
    return (
      <PageShell>
        <PageHeader title={t('analytics.title')} icon={<BarChart3 size={19} />} />
        <Panel title={t('common.loading')} icon={<Clock3 size={17} />}>
          <EmptyPanel>
            <span className="loading-spinner" />
            {t('common.loading')}
          </EmptyPanel>
        </Panel>
      </PageShell>
    );
  }

  return (
    <PageShell>
      <PageHeader
        title={t('analytics.title')}
        subtitle={t('analytics.insight_title')}
        icon={<BarChart3 size={19} />}
        actions={
          <>
            <button className="btn btn-secondary" onClick={loadData}>
              <RefreshCw size={16} />
              {t('common.retry')}
            </button>
            <button className="btn btn-primary" onClick={handleRefresh} disabled={isRefreshing || dreamInsightsLoading}>
              <Brain size={16} />
              {isRefreshing ? t('analytics.buttons.refreshing') : t('analytics.buttons.refresh')}
            </button>
          </>
        }
      />

      <div className="metric-grid">
        <MetricCard label={t('analytics.total_tasks')} value={tasks.length} hint={`${pendingCount} ${t('tasks.pending')}`} />
        <MetricCard label={t('analytics.completed')} value={completedCount} hint={`${tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0}%`} tone="good" />
        <MetricCard label={t('analytics.pending')} value={pendingCount} hint={t('tasks.view_list')} tone={pendingCount > 0 ? 'warn' : undefined} />
        <MetricCard label={t('analytics.daily_avg')} value={averageDailyCompletion.toFixed(1)} hint={t('analytics.daily_trend')} />
        <MetricCard label={t('analytics.schedule_rate')} value={`${scheduleAdherence.rate}%`} hint={t('analytics.schedule_hint')} tone={efficiencyTone(scheduleAdherence.rate)} />
      </div>

      <SegmentedTabs<AnalyticsTab>
        value={activeTab}
        onChange={setActiveTab}
        ariaLabel={t('analytics.title')}
        items={[
          { value: 'overview', label: t('analytics.overview'), icon: <BarChart3 size={15} /> },
          { value: 'projects', label: t('analytics.projects'), icon: <BriefcaseBusiness size={15} /> },
          { value: 'productivity', label: t('analytics.productivity'), icon: <Clock3 size={15} /> },
          { value: 'dream', label: t('analytics.dream'), icon: <Brain size={15} /> },
        ]}
      />

      {activeTab === 'overview' && renderOverview()}
      {activeTab === 'projects' && renderProjects()}
      {activeTab === 'productivity' && renderProductivity()}
      {activeTab === 'dream' && <DreamInsightsPanel />}
    </PageShell>
  );
}
