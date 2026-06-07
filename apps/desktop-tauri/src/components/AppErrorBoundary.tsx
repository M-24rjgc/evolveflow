import React from 'react';

// ── Types ─────────────────────────────────────────────────────────

type ErrorCategory = 'network' | 'auth' | 'unknown';

interface ErrorLogEntry {
  id: string;
  timestamp: string;
  message: string;
  stack?: string;
  category: ErrorCategory;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorId: string;
  category: ErrorCategory;
}

// ── Error Log Storage ─────────────────────────────────────────────

const ERROR_LOG_KEY = 'evolveflow_error_log';
const MAX_ERROR_LOG = 20;

function generateErrorId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `err_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

function categorizeError(error: Error): ErrorCategory {
  const msg = error.message || '';
  const name = error.name || '';
  if (
    msg.includes('network') ||
    msg.includes('fetch') ||
    msg.includes('NetworkError') ||
    msg.includes('ERR_CONNECTION') ||
    msg.includes('ERR_NETWORK') ||
    msg.includes('timeout') ||
    msg.includes('Failed to fetch') ||
    msg.includes('load')
  ) {
    return 'network';
  }
  if (
    msg.includes('auth') ||
    msg.includes('unauthorized') ||
    msg.includes('forbidden') ||
    msg.includes('401') ||
    msg.includes('403') ||
    msg.includes('API key') ||
    msg.includes('API Key') ||
    msg.includes('not initialized')
  ) {
    return 'auth';
  }
  return 'unknown';
}

function loadErrorLog(): ErrorLogEntry[] {
  try {
    const stored = localStorage.getItem(ERROR_LOG_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as ErrorLogEntry[];
      if (Array.isArray(parsed)) {return parsed;}
    }
  } catch {
    // Corrupted data
  }
  return [];
}

function saveErrorLog(entry: ErrorLogEntry): void {
  try {
    const log = loadErrorLog();
    log.push(entry);
    // Keep only most recent entries
    const trimmed = log.slice(-MAX_ERROR_LOG);
    localStorage.setItem(ERROR_LOG_KEY, JSON.stringify(trimmed));
  } catch {
    // Storage quota exceeded or unavailable
  }
}

// ── Component ─────────────────────────────────────────────────────

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = {
      hasError: false,
      error: null,
      errorId: '',
      category: 'unknown',
    };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    const category = categorizeError(error);
    return {
      hasError: true,
      error,
      errorId: generateErrorId(),
      category,
    };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log to console in dev
    console.error('AppErrorBoundary caught:', error, errorInfo);

    // Persist to localStorage error log
    const entry: ErrorLogEntry = {
      id: this.state.errorId || generateErrorId(),
      timestamp: new Date().toISOString(),
      message: error.message || String(error),
      stack: error.stack,
      category: categorizeError(error),
    };
    saveErrorLog(entry);
  }

  handleCopyDetails = (): void => {
    const { error, errorId, category } = this.state;
    const details = [
      `Error ID: ${errorId}`,
      `Category: ${category}`,
      `Time: ${new Date().toISOString()}`,
      `Message: ${error?.message || 'Unknown'}`,
      `Stack: ${error?.stack || 'N/A'}`,
    ].join('\n');

    try {
      navigator.clipboard.writeText(details).catch(() => {
        // Fallback for older browsers
        const textArea = document.createElement('textarea');
        textArea.value = details;
        document.body.appendChild(textArea);
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      });
    } catch {
      // Clipboard unavailable — silently fail
    }
  };

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null, errorId: '', category: 'unknown' });
  };

  getCategoryLabel(): string {
    switch (this.state.category) {
      case 'network':
        return '网络错误 / Network Error';
      case 'auth':
        return '认证错误 / Authentication Error';
      default:
        return '未知错误 / Unknown Error';
    }
  }

  getCategoryIcon(): string {
    switch (this.state.category) {
      case 'network':
        return '\u{1F4E1}';
      case 'auth':
        return '\u{1F512}';
      default:
        return '\u{26A0}\u{FE0F}';
    }
  }

  render() {
    if (this.state.hasError) {
      const { errorId, category, error } = this.state;

      return (
        <div
          style={{
            padding: 40,
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 16,
            maxWidth: 480,
            margin: '40px auto',
          }}
        >
          {/* Error Icon */}
          <div
            style={{
              width: 64,
              height: 64,
              borderRadius: '50%',
              background:
                category === 'network'
                  ? 'var(--warning-bg, #fff8e1)'
                  : category === 'auth'
                    ? 'var(--warning-bg, #fff8e1)'
                    : 'var(--danger-bg, #ffebee)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 28,
            }}
          >
            {this.getCategoryIcon()}
          </div>

          {/* Title */}
          <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text-primary, #333)', margin: 0 }}>
            {this.getCategoryLabel()}
          </h2>

          {/* Description */}
          <p style={{ color: 'var(--text-muted, #888)', fontSize: 14, lineHeight: 1.5, margin: 0 }}>
            {category === 'network'
              ? '网络连接出现问题，请检查你的网络连接后重试。'
              : category === 'auth'
                ? 'API 认证失败，请在设置页面检查你的 API Key 配置。'
                : '应用遇到了一个意外错误。请尝试刷新页面。'}
          </p>

          {/* Error ID */}
          <div
            style={{
              fontSize: 12,
              color: 'var(--text-disabled, #aaa)',
              background: 'var(--bg-muted, #f8f9fa)',
              padding: '6px 12px',
              borderRadius: 6,
              fontFamily: 'monospace',
            }}
          >
            {'Error ID'}: {errorId}
          </div>

          {/* Error Details (collapsible) */}
          {error && (
            <details
              style={{
                width: '100%',
                textAlign: 'left',
                fontSize: 12,
                color: 'var(--text-muted, #888)',
              }}
            >
              <summary style={{ cursor: 'pointer', fontWeight: 500 }}>
                {'\u{1F4CB}'} {'Details'}
              </summary>
              <pre
                style={{
                  marginTop: 8,
                  padding: 12,
                  background: 'var(--bg-muted, #f8f9fa)',
                  borderRadius: 6,
                  fontSize: 11,
                  color: 'var(--text-secondary, #555)',
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: 200,
                  overflowY: 'auto',
                }}
              >
                {error.stack || error.message}
              </pre>
            </details>
          )}

          {/* Action Buttons */}
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', justifyContent: 'center' }}>
            <button
              className="btn btn-primary"
              onClick={this.handleRetry}
              style={{
                padding: '10px 24px',
                fontSize: 14,
              }}
            >
              {'\u{1F504}'} {'Retry'}
            </button>
            <button
              className="btn btn-secondary"
              onClick={this.handleCopyDetails}
              style={{
                padding: '10px 24px',
                fontSize: 14,
              }}
            >
              {'\u{1F4CB}'} {'Copy Error Details'}
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

export default AppErrorBoundary;
