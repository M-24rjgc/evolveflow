import React, { useState, useEffect, useCallback } from 'react';
import { callCapability } from '../lib/tauri';
import { useI18n, type Locale } from '../lib/i18n';

// ── Types ──────────────────────────────────────────────────────

interface DreamInsight {
  id: string;
  category: 'productivity' | 'energy' | 'scheduling' | 'habit' | 'adherence' | 'issue';
  insight_text: string;
  confidence: number;
  supporting_data: string | null;
  created_at: string;
}

interface DreamStatus {
  isRunning: boolean;
  lastDreamTime: string | null;
  sessionCount: number;
}

// ── Category Config ─────────────────────────────────────────────

const CATEGORY_CONFIG: Record<string, { icon: string; color: string }> = {
  productivity: { icon: '\u{1F4C8}', color: '#4caf50' },
  energy: { icon: '⚡', color: '#ff9800' },
  scheduling: { icon: '\u{1F4C5}', color: '#4a6fa5' },
  habit: { icon: '\u{1F504}', color: '#9c27b0' },
  adherence: { icon: '✅', color: '#00bcd4' },
  issue: { icon: '⚠️', color: '#f44336' },
};

// ── Confidence Dots ────────────────────────────────────────────

function ConfidenceDots({ confidence, t }: { confidence: number; t: (key: string, params?: Record<string, string | number>) => string }) {
  const filled = Math.round(Math.min(confidence, 1) * 5);
  return (
    <span
      style={{ letterSpacing: 2, fontSize: 14, color: '#bbb' }}
      title={t('dream.confidence', { pct: (confidence * 100).toFixed(0) })}
    >
      {'●'.repeat(filled)}
      {'○'.repeat(Math.max(0, 5 - filled))}
    </span>
  );
}

// ── Main Component ─────────────────────────────────────────────

export default function DreamInsightsPanel() {
  const { t, locale } = useI18n();
  const [insights, setInsights] = useState<DreamInsight[]>([]);
  const [dreamStatus, setDreamStatus] = useState<DreamStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRunning, setIsRunning] = useState(false);
  const [expandedInsights, setExpandedInsights] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    try {
      const [insightsResult, statusResult] = await Promise.all([
        callCapability('dream.get_insights', { limit: 20 }) as Promise<{
          success: boolean;
          data?: DreamInsight[];
        }>,
        callCapability('dream.status', {}) as Promise<DreamStatus>,
      ]);

      if (insightsResult.success && insightsResult.data) {
        setInsights(insightsResult.data);
      } else if (insightsResult.success) {
        setInsights([]);
      }
      setDreamStatus(statusResult);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  const handleAnalyzeNow = async () => {
    setIsRunning(true);
    setError(null);
    try {
      const result = await callCapability('dream.run', {}) as {
        status: string;
        insights?: DreamInsight[];
      };
      if (result.status === 'already_running') {
        setError(t('dream.error_already_running'));
      } else {
        // Wait a brief moment for DB writes to settle, then refresh
        setTimeout(() => loadData(), 1000);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setIsRunning(false);
    }
  };

  const toggleEvidence = (id: string) => {
    setExpandedInsights((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const formatDate = (dateStr: string, locale: Locale): string => {
    try {
      const d = new Date(dateStr);
      return d.toLocaleDateString(locale === 'en-US' ? 'en-US' : 'zh-CN', {
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      return dateStr?.slice(0, 10) || '';
    }
  };

  // ── Loading State ───────────────────────────────────────────

  if (isLoading) {
    return (
      <div>
        <h3 className="card-title" style={{ marginBottom: 12 }}>{'\u{1F9E0}'} {t('dream.title')}</h3>
        <div className="card" style={{ textAlign: 'center', padding: 40 }}>
          <div className="loading-spinner" />
          <p style={{ fontSize: 13, color: '#888', marginTop: 12 }}>{t('dream.loading')}</p>
        </div>
      </div>
    );
  }

  // ── Render ──────────────────────────────────────────────────

  return (
    <div>
      {/* Dream System Status Card */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
          <h3 className="card-title" style={{ margin: 0 }}>{'\u{1F9E0}'} {t('dream.title')}</h3>
          <button
            className="btn btn-primary"
            onClick={handleAnalyzeNow}
            disabled={isRunning}
            style={{ fontSize: 12, padding: '6px 14px' }}
          >
            {isRunning ? '\u{23F3} ' + t('dream.analyzing') : '\u{1F50D} ' + t('dream.analyze')}
          </button>
        </div>

        <div
          style={{
            display: 'flex',
            gap: 20,
            marginTop: 10,
            fontSize: 12,
            color: '#888',
            flexWrap: 'wrap',
          }}
        >
          <span>
            {'\u{1F504}'} {t('dream.status')}:{' '}
            <strong style={{ color: dreamStatus?.isRunning ? '#ff9800' : '#4caf50' }}>
              {dreamStatus?.isRunning ? t('dream.status_running') : t('dream.status_idle')}
            </strong>
          </span>
          <span>
            {'\u{1F550}'} {t('dream.last_analysis')}:{' '}
            {dreamStatus?.lastDreamTime
              ? new Date(dreamStatus.lastDreamTime).toLocaleString(locale === 'en-US' ? 'en-US' : 'zh-CN')
              : t('dream.not_run')}
          </span>
          <span>
            {'\u{1F4CA}'} {t('dream.session')}: {t('dream.session_count', { count: dreamStatus?.sessionCount ?? 0 })}
          </span>
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div
          className="card"
          style={{
            padding: '8px 12px',
            marginBottom: 12,
            background: '#fff3e0',
            border: '1px solid #ffcc80',
            fontSize: 13,
          }}
        >
          {'⚠️'} {error}
          <button
            className="btn btn-secondary"
            style={{ marginLeft: 12, fontSize: 11, padding: '1px 8px' }}
            onClick={() => setError(null)}
          >
            {t('dream.close')}
          </button>
        </div>
      )}

      {/* Empty State */}
      {insights.length === 0 && !error && (
        <div className="card" style={{ textAlign: 'center', padding: 50 }}>
          <div style={{ fontSize: 48, marginBottom: 12 }}>{'\u{1F331}'}</div>
          <p style={{ fontSize: 15, color: '#555', marginBottom: 8, fontWeight: 500 }}>
            {t('dream.empty_title')}
          </p>
          <p style={{ fontSize: 13, color: '#888', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
            {t('dream.empty_desc')}
          </p>
        </div>
      )}

      {/* Insights List */}
      {insights.map((insight) => {
        const config = CATEGORY_CONFIG[insight.category] || CATEGORY_CONFIG.productivity;
        const isExpanded = expandedInsights.has(insight.id);

        let evidenceData: Record<string, unknown> | null = null;
        if (insight.supporting_data) {
          try {
            evidenceData = JSON.parse(insight.supporting_data);
          } catch {
            evidenceData = null;
          }
        }
        const hasEvidence = evidenceData && Object.keys(evidenceData).length > 0;

        return (
          <div
            key={insight.id}
            className="card"
            style={{
              marginBottom: 12,
              borderLeft: `3px solid ${config.color}`,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
              {/* Category Icon */}
              <div
                style={{
                  width: 38,
                  height: 38,
                  borderRadius: 8,
                  background: `${config.color}15`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 18,
                  flexShrink: 0,
                }}
              >
                {config.icon}
              </div>

              <div style={{ flex: 1, minWidth: 0 }}>
                {/* Header Row */}
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 3,
                    flexWrap: 'wrap',
                    gap: 4,
                  }}
                >
                  <span style={{ fontSize: 11, color: config.color, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>
                    {t('dream.categories.' + insight.category)}
                  </span>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <ConfidenceDots confidence={insight.confidence} t={t} />
                    <span style={{ fontSize: 11, color: '#aaa' }}>
                      {formatDate(insight.created_at, locale)}
                    </span>
                  </div>
                </div>

                {/* Insight Text */}
                <p
                  style={{
                    fontSize: 13.5,
                    color: '#333',
                    lineHeight: 1.6,
                    margin: '4px 0',
                    wordBreak: 'break-word',
                  }}
                >
                  {insight.insight_text}
                </p>

                {/* Evidence Section */}
                {hasEvidence && (
                  <div style={{ marginTop: 6 }}>
                    <button
                      className="btn btn-secondary"
                      style={{ fontSize: 11, padding: '2px 10px' }}
                      onClick={() => toggleEvidence(insight.id)}
                      aria-expanded={isExpanded}
                    >
                      {isExpanded ? '\u{1F4D6} ' + t('dream.hide_evidence') : '\u{1F50D} ' + t('dream.view_evidence')}
                    </button>
                    {isExpanded && (
                      <pre
                        style={{
                          marginTop: 8,
                          padding: 10,
                          background: '#f7f7f7',
                          borderRadius: 6,
                          fontSize: 11,
                          lineHeight: 1.5,
                          overflowX: 'auto',
                          whiteSpace: 'pre-wrap',
                          fontFamily: 'Consolas, "Fira Code", monospace',
                          color: '#555',
                          border: '1px solid #e8e8e8',
                        }}
                      >
                        {JSON.stringify(evidenceData, null, 2)}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}

      {/* Footer note */}
      {insights.length > 0 && (
        <p style={{ fontSize: 11, color: '#bbb', textAlign: 'center', marginTop: 8 }}>
          {'\u{2139}️'} {t('dream.footer')}
        </p>
      )}
    </div>
  );
}
