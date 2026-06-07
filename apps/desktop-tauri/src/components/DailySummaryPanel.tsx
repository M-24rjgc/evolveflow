import React, { useState, useEffect, useCallback } from 'react';
import { callCapability } from '../lib/tauri';
import { useToast } from './Toast';
import { useI18n } from '../lib/i18n';

// ── Types ──────────────────────────────────────────────────────

interface DailySummary {
  date: string;
  total_completed: number;
  total_tasks: number;
  events_attended: number;
  total_events: number;
  completed_items: Array<{
    id: string;
    title: string;
    type: 'task' | 'event';
    completed_at: string;
  }>;
  incomplete_items: Array<{
    id: string;
    title: string;
    type: 'task' | 'event';
    reason?: string;
  }>;
  deferred_items: Array<{
    id: string;
    title: string;
    deferred_at: string;
  }>;
  insights?: string[];
  // For previous summaries
  summary_text?: string;
}

interface SummaryResult {
  success: boolean;
  data?: DailySummary;
}

interface SummaryListItem {
  date: string;
  summary?: string;
  completed_count: number;
  total_count: number;
}

// ── Helpers ────────────────────────────────────────────────────

function formatDate(dateStr: string, locale: string): string {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString(locale === 'en-US' ? 'en-US' : 'zh-CN', {
      month: 'numeric',
      day: 'numeric',
      weekday: 'short',
    });
  } catch {
    return dateStr;
  }
}

function formatTime(isoStr: string, locale: string): string {
  try {
    const d = new Date(isoStr);
    return d.toLocaleTimeString(locale === 'en-US' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return isoStr?.slice(11, 16) || '';
  }
}

// Visual thresholds for color coding — not AI, purely visual
const RATE_HIGH = 80;
const RATE_MEDIUM = 50;

// ── Component ──────────────────────────────────────────────────

export default function DailySummaryPanel() {
  const { t, locale } = useI18n();
  const toast = useToast();

  const [todaySummary, setTodaySummary] = useState<DailySummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [previousSummaries, setPreviousSummaries] = useState<SummaryListItem[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [expandedDays, setExpandedDays] = useState<Set<string>>(new Set());
  const [expandedDayData, setExpandedDayData] = useState<Map<string, DailySummary>>(new Map());
  const [loadingDay, setLoadingDay] = useState<string | null>(null);

  const today = new Date().toISOString().split('T')[0];

  // ── Load Today's Summary ────────────────────────────────────

  const loadTodaySummary = useCallback(async () => {
    setIsLoading(true);
    try {
      // Load tasks and events to calculate stats
      const [taskResult, eventResult] = await Promise.all([
        callCapability('task.list', {}) as Promise<{ success: boolean; data?: Array<Record<string, unknown>> }>,
        callCapability('event.list', {
          start: `${today}T00:00:00`,
          end: `${today}T23:59:59`,
        }) as Promise<{ success: boolean; data?: Array<Record<string, unknown>> }>,
      ]);

      const allTasks = (taskResult.success ? taskResult.data : []) || [];
      const completedTasks = allTasks.filter((t: Record<string, unknown>) =>
        t.status === 'completed' && (t.completed_at as string || '').startsWith(today)
      );
      const incompleteTasks = allTasks.filter((t: Record<string, unknown>) =>
        t.status === 'pending'
      );
      const deferredTasks = allTasks.filter((t: Record<string, unknown>) =>
        t.status === 'deferred'
      );

      const todayEvents = (eventResult.success ? eventResult.data : []) || [];

      setTodaySummary({
        date: today,
        total_completed: completedTasks.length,
        total_tasks: allTasks.length,
        events_attended: todayEvents.length,
        total_events: todayEvents.length,
        completed_items: completedTasks.map((item: Record<string, unknown>) => ({
          id: item.id as string,
          title: item.title as string,
          type: 'task' as const,
          completed_at: (item.completed_at as string) || (item.updated_at as string) || '',
        })),
        incomplete_items: [
          ...incompleteTasks.map((item: Record<string, unknown>) => ({
            id: item.id as string,
            title: item.title as string,
            type: 'task' as const,
            reason: item.due_date ? (item.due_date as string).startsWith(today) ? t('summary.due_today') : undefined : undefined,
          })),
          ...todayEvents.filter((e: Record<string, unknown>) => !e.locked).map((e: Record<string, unknown>) => ({
            id: e.id as string,
            title: e.title as string,
            type: 'event' as const,
            reason: t('summary.need_attend'),
          })),
        ],
        deferred_items: deferredTasks.map((item: Record<string, unknown>) => ({
          id: item.id as string,
          title: item.title as string,
          deferred_at: (item.updated_at as string) || '',
        })),
      });
    } catch {
      // silent
    } finally {
      setIsLoading(false);
    }
  }, [today]);

  useEffect(() => {
    loadTodaySummary();
  }, [loadTodaySummary]);

  // ── Generate Summary ─────────────────────────────────────────

  async function handleGenerateSummary() {
    setIsGenerating(true);
    try {
      const result = await callCapability('summary.generate_daily', {
        date: today,
      }) as SummaryResult;

      if (result.success && result.data) {
        // Merge AI insights into the existing summary data,
        // keeping the locally-computed stats (with proper object format)
        // while adding the AI-generated content from the backend response.
        setTodaySummary((prev) => {
          if (!prev) {return result.data!;}
          return {
            ...prev,
            insights: (result.data as any).insights || [],
            summary_text: (result.data as any).summary_text || '',
          };
        });
        toast.success(t('summary.title') + ' ' + t('common.loading'));
      } else {
        toast.error(t('summary.generate') + t('common.loading'));
      }
    } catch (err) {
      toast.error(t('summary.generate') + t('common.loading') + ': ' + (err instanceof Error ? err.message : String(err)));
    } finally {
      setIsGenerating(false);
    }
  }

  // ── Load Previous Summaries ─────────────────────────────────

  useEffect(() => {
    if (!showHistory) {return;}

    async function loadHistory() {
      const days: SummaryListItem[] = [];
      for (let i = 1; i <= 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toISOString().split('T')[0];
        try {
          const result = await callCapability('task.list', {}) as {
            success: boolean;
            data?: Array<Record<string, unknown>>;
          };
          if (result.success && result.data) {
            const dayTasks = result.data.filter((t: Record<string, unknown>) => {
              const updated = (t.updated_at as string) || '';
              return updated.startsWith(dateStr) || (t.due_date as string || '').startsWith(dateStr);
            });
            const completed = dayTasks.filter((t: Record<string, unknown>) => t.status === 'completed');
            days.push({
              date: dateStr,
              completed_count: completed.length,
              total_count: dayTasks.length,
            });
          }
        } catch {
          days.push({ date: dateStr, completed_count: 0, total_count: 0 });
        }
      }
      setPreviousSummaries(days);
    }

    loadHistory();
  }, [showHistory]);

  // ── Load Detailed Day Data ──────────────────────────────────

  async function handleExpandDay(dateStr: string) {
    if (expandedDays.has(dateStr)) {
      setExpandedDays((prev) => {
        const next = new Set(prev);
        next.delete(dateStr);
        return next;
      });
      return;
    }

    setLoadingDay(dateStr);
    try {
      const [taskResult, eventResult] = await Promise.all([
        callCapability('task.list', {}) as Promise<{ success: boolean; data?: Array<Record<string, unknown>> }>,
        callCapability('event.list', {
          start: `${dateStr}T00:00:00`,
          end: `${dateStr}T23:59:59`,
        }) as Promise<{ success: boolean; data?: Array<Record<string, unknown>> }>,
      ]);

      const allTasks = (taskResult.success ? taskResult.data : []) || [];
      const dayEvents = (eventResult.success ? eventResult.data : []) || [];

      const completedItems = allTasks
        .filter((t: Record<string, unknown>) => t.status === 'completed' && (t.updated_at as string || '').startsWith(dateStr))
        .map((item: Record<string, unknown>) => ({
          id: item.id as string,
          title: item.title as string,
          type: 'task' as const,
          completed_at: (item.updated_at as string) || '',
        }));

      setExpandedDayData((prev) => {
        const next = new Map(prev);
        next.set(dateStr, {
          date: dateStr,
          total_completed: completedItems.length,
          total_tasks: allTasks.length,
          events_attended: dayEvents.length,
          total_events: dayEvents.length,
          completed_items: completedItems,
          incomplete_items: [],
          deferred_items: [],
        });
        return next;
      });

      setExpandedDays((prev) => {
        const next = new Set(prev);
        next.add(dateStr);
        return next;
      });
    } catch {
      toast.error(t('common.loading') + ' ' + dateStr);
    } finally {
      setLoadingDay(null);
    }
  }

  // ── Stats ────────────────────────────────────────────────────

  const completionRate = todaySummary
    ? todaySummary.total_tasks > 0
      ? Math.round((todaySummary.total_completed / todaySummary.total_tasks) * 100)
      : 0
    : 0;

  const eventRate = todaySummary && todaySummary.total_events > 0
    ? Math.round((todaySummary.events_attended / todaySummary.total_events) * 100)
    : 0;

  // ── Render ───────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="card">
        <h3 className="card-title">{t('summary.title')}</h3>
        <div className="loading-spinner" />
      </div>
    );
  }

  return (
    <div className="card">
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 16,
        }}
      >
        <h3 className="card-title" style={{ margin: 0 }}>
          📊 {t('summary.title')}
        </h3>
        <div style={{ display: 'flex', gap: 8 }}>
          <button
            className="btn btn-secondary"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={() => { setShowHistory(!showHistory); }}
          >
            {showHistory ? t('summary.hide_history') : t('summary.history')}
          </button>
          <button
            className="btn btn-primary"
            style={{ fontSize: 12, padding: '4px 10px' }}
            onClick={handleGenerateSummary}
            disabled={isGenerating}
          >
            {isGenerating ? (
              <>
                <span className="loading-spinner" style={{ width: 12, height: 12, margin: 0, display: 'inline-block', verticalAlign: 'middle' }} />
                {t('summary.generating')}
              </>
            ) : (
              t('summary.generate')
            )}
          </button>
        </div>
      </div>

      {/* Today's Stats */}
      {todaySummary && (
        <div>
          {/* Completion Stats */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
              gap: 12,
              marginBottom: 16,
            }}
          >
            <StatCard label={t('summary.completed_tasks')} value={todaySummary.total_completed} color="#4caf50" />
            <StatCard label={t('summary.total_tasks')} value={todaySummary.total_tasks} color="#4a6fa5" />
            <StatCard label={t('summary.events_count')} value={todaySummary.events_attended} color="#3b82f6" />
            <StatCard label={t('summary.completion_rate')} value={`${completionRate}%`} color={completionRate >= RATE_HIGH ? '#4caf50' : completionRate >= RATE_MEDIUM ? '#ff9800' : '#f44336'} />
          </div>

          {/* Progress Bar */}
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#888', marginBottom: 4 }}>
              <span>{t('summary.progress_label')}</span>
              <span>{todaySummary.total_completed}/{todaySummary.total_tasks}</span>
            </div>
            <div
              style={{
                width: '100%',
                height: 8,
                background: '#e9ecef',
                borderRadius: 4,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  width: `${completionRate}%`,
                  height: '100%',
                  background: completionRate >= RATE_HIGH ? '#4caf50' : completionRate >= RATE_MEDIUM ? '#ff9800' : '#f44336',
                  borderRadius: 4,
                  transition: 'width 0.5s ease',
                }}
              />
            </div>
          </div>

          {/* Event Attendance */}
          {todaySummary.total_events > 0 && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, color: '#888', marginBottom: 4 }}>
                <span>{t('summary.event_attendance')}</span>
                <span>{todaySummary.events_attended}/{todaySummary.total_events}</span>
              </div>
              <div
                style={{
                  width: '100%',
                  height: 8,
                  background: '#e9ecef',
                  borderRadius: 4,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    width: `${eventRate}%`,
                    height: '100%',
                    background: '#3b82f6',
                    borderRadius: 4,
                    transition: 'width 0.5s ease',
                  }}
                />
              </div>
            </div>
          )}

          {/* Completed Items */}
          {todaySummary.completed_items.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#4caf50', marginBottom: 8 }}>
                ✓ {t('summary.completed_section', { count: todaySummary.completed_items.length })}
              </div>
              {todaySummary.completed_items.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 0',
                    fontSize: 13,
                    color: '#555',
                  }}
                >
                  <span style={{ color: '#4caf50' }}>✓</span>
                  <span style={{ flex: 1 }}>{item.title}</span>
                  {item.completed_at && (
                    <span style={{ fontSize: 11, color: '#888' }}>
                      {formatTime(item.completed_at, locale)}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Incomplete Items */}
          {todaySummary.incomplete_items.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#ff9800', marginBottom: 8 }}>
                ○ {t('summary.pending_section', { count: todaySummary.incomplete_items.length })}
              </div>
              {todaySummary.incomplete_items.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 0',
                    fontSize: 13,
                    color: '#888',
                  }}
                >
                  <span style={{ color: '#ff9800' }}>○</span>
                  <span style={{ flex: 1 }}>{item.title}</span>
                  {item.reason && (
                    <span style={{ fontSize: 11, color: '#ef4444' }}>{item.reason}</span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Deferred Items */}
          {todaySummary.deferred_items.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: '#9e9e9e', marginBottom: 8 }}>
                ↻ {t('summary.deferred_section', { count: todaySummary.deferred_items.length })}
              </div>
              {todaySummary.deferred_items.map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    padding: '4px 0',
                    fontSize: 13,
                    color: '#999',
                  }}
                >
                  <span style={{ color: '#9e9e9e' }}>↻</span>
                  <span style={{ flex: 1 }}>{item.title}</span>
                  {item.deferred_at && (
                    <span style={{ fontSize: 11, color: '#888' }}>
                      {t('summary.deferred_at', { time: formatTime(item.deferred_at, locale) })}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* AI Insights */}
          {todaySummary.insights && todaySummary.insights.length > 0 && (
            <div
              style={{
                padding: 12,
                background: '#f0f4ff',
                borderRadius: 8,
                fontSize: 13,
                color: '#4a6fa5',
                lineHeight: 1.6,
              }}
            >
              <strong>💡 {t('summary.ai_insights')}：</strong>
              <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                {todaySummary.insights.map((insight, i) => (
                  <li key={i} style={{ marginBottom: 4 }}>{insight}</li>
                ))}
              </ul>
            </div>
          )}

          {todaySummary.total_tasks === 0 && todaySummary.total_events === 0 && (
            <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: 20 }}>
              {t('summary.no_activity')}
            </p>
          )}
        </div>
      )}

      {/* Previous Summaries History */}
      {showHistory && (
        <div style={{ marginTop: 16, borderTop: '1px solid #e9ecef', paddingTop: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#555', marginBottom: 12 }}>
            {t('summary.history_title')}
          </div>
          {previousSummaries.length === 0 ? (
            <p style={{ fontSize: 13, color: '#888', textAlign: 'center', padding: 12 }}>
              {t('summary.no_history')}
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {previousSummaries.map((day) => {
                const rate = day.total_count > 0
                  ? Math.round((day.completed_count / day.total_count) * 100)
                  : 0;
                const isExpanded = expandedDays.has(day.date);
                const isLoadingDay = loadingDay === day.date;

                return (
                  <div key={day.date}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '8px 12px',
                        background: '#f8f9fa',
                        borderRadius: 6,
                        cursor: 'pointer',
                        fontSize: 13,
                      }}
                      onClick={() => handleExpandDay(day.date)}
                    >
                      <span style={{ fontWeight: 500, minWidth: 90 }}>{formatDate(day.date, locale)}</span>
                      <span style={{ color: rate >= RATE_HIGH ? '#4caf50' : rate >= RATE_MEDIUM ? '#ff9800' : '#f44336', fontWeight: 600, minWidth: 50 }}>
                        {rate}%
                      </span>
                      <div
                        style={{
                          flex: 1,
                          height: 6,
                          background: '#e9ecef',
                          borderRadius: 3,
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            width: `${rate}%`,
                            height: '100%',
                            background: rate >= RATE_HIGH ? '#4caf50' : rate >= RATE_MEDIUM ? '#ff9800' : '#f44336',
                            borderRadius: 3,
                          }}
                        />
                      </div>
                      <span style={{ color: '#888', fontSize: 12, minWidth: 60, textAlign: 'right' }}>
                        {day.completed_count}/{day.total_count}
                      </span>
                      <span style={{ color: '#aaa', fontSize: 12 }}>
                        {isLoadingDay ? '⏳' : isExpanded ? '▲' : '▼'}
                      </span>
                    </div>

                    {/* Expanded day detail */}
                    {isExpanded && expandedDayData.get(day.date) && (
                      <div style={{ padding: '8px 12px 8px 24px', fontSize: 12, color: '#666' }}>
                        {expandedDayData.get(day.date)!.completed_items.length > 0 && (
                          <div>
                            <span style={{ fontWeight: 600, color: '#4caf50' }}>{t('summary.completed_tasks')}：</span>
                            {expandedDayData.get(day.date)!.completed_items.map((item) => (
                              <div key={item.id} style={{ padding: '2px 0' }}>
                                ✓ {item.title}
                                {item.completed_at && <span style={{ color: '#aaa' }}> ({formatTime(item.completed_at, locale)})</span>}
                              </div>
                            ))}
                          </div>
                        )}
                        {expandedDayData.get(day.date)!.completed_items.length === 0 && (
                          <span style={{ color: '#aaa' }}>{t('summary.no_records')}</span>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Stat Card ─────────────────────────────────────────────────

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color: string;
}) {
  return (
    <div
      style={{
        padding: '12px',
        background: '#f8f9fa',
        borderRadius: 8,
        border: `1px solid #e9ecef`,
        borderTop: `3px solid ${color}`,
      }}
    >
      <div style={{ fontSize: 11, color: '#888', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 700, color }}>{value}</div>
    </div>
  );
}
