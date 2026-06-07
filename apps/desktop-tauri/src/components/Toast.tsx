import React, { createContext, useContext, useState, useCallback, useRef, useEffect, type ReactNode } from 'react';

// ── Types ──────────────────────────────────────────────────────

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface Toast {
  id: string;
  type: ToastType;
  message: string;
  duration: number;
  createdAt: number;
  exiting: boolean;
}

interface ToastContextValue {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, 'id' | 'createdAt' | 'exiting'>) => string;
  removeToast: (id: string) => void;
  success: (message: string, duration?: number) => string;
  error: (message: string, duration?: number) => string;
  warning: (message: string, duration?: number) => string;
  info: (message: string, duration?: number) => string;
  clearAll: () => void;
}

// ── Constants ──────────────────────────────────────────────────

const MAX_VISIBLE_TOASTS = 5;
const DEFAULT_DURATION = 3000;
const EXIT_ANIMATION_DURATION = 300;

// ── Context ────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null);

let toastCounter = 0;
function generateToastId(): string {
  toastCounter += 1;
  return `toast_${Date.now()}_${toastCounter}`;
}

// ── Provider ───────────────────────────────────────────────────

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const exitTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Cleanup all timers on unmount
  useEffect(() => {
    return () => {
      timersRef.current.forEach((timer) => clearTimeout(timer));
      exitTimersRef.current.forEach((timer) => clearTimeout(timer));
      timersRef.current.clear();
      exitTimersRef.current.clear();
    };
  }, []);

  const removeToast = useCallback((id: string) => {
    // Clear any pending timers
    if (timersRef.current.has(id)) {
      clearTimeout(timersRef.current.get(id)!);
      timersRef.current.delete(id);
    }
    if (exitTimersRef.current.has(id)) {
      clearTimeout(exitTimersRef.current.get(id)!);
      exitTimersRef.current.delete(id);
    }

    // Start exit animation
    setToasts((prev) =>
      prev.map((t) => (t.id === id ? { ...t, exiting: true } : t))
    );

    // Remove after animation completes
    const exitTimer = setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
      exitTimersRef.current.delete(id);
    }, EXIT_ANIMATION_DURATION);
    exitTimersRef.current.set(id, exitTimer);
  }, []);

  const addToast = useCallback(
    (toastData: Omit<Toast, 'id' | 'createdAt' | 'exiting'>): string => {
      const id = generateToastId();
      const newToast: Toast = {
        ...toastData,
        id,
        createdAt: Date.now(),
        exiting: false,
      };

      setToasts((prev) => {
        // Enforce max visible
        const updated = [...prev, newToast];
        if (updated.length > MAX_VISIBLE_TOASTS) {
          // Remove oldest non-exiting toast immediately
          const oldest = updated.find((t) => !t.exiting);
          if (oldest && oldest.id !== id) {
            // We'll trigger removal rather than mutating
            setTimeout(() => removeToast(oldest.id), 0);
          }
          // Keep only most recent MAX_VISIBLE_TOASTS
          const nonExiting = updated.filter((t) => t.exiting);
          const recent = updated.filter((t) => !t.exiting).slice(-MAX_VISIBLE_TOASTS);
          return [...nonExiting, ...recent];
        }
        return updated;
      });

      // Auto-dismiss
      if (toastData.duration > 0) {
        const timer = setTimeout(() => {
          removeToast(id);
        }, toastData.duration);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [removeToast]
  );

  const success = useCallback(
    (message: string, duration: number = DEFAULT_DURATION): string => {
      return addToast({ type: 'success', message, duration });
    },
    [addToast]
  );

  const error = useCallback(
    (message: string, duration: number = DEFAULT_DURATION): string => {
      return addToast({ type: 'error', message, duration });
    },
    [addToast]
  );

  const warning = useCallback(
    (message: string, duration: number = DEFAULT_DURATION * 1.5): string => {
      return addToast({ type: 'warning', message, duration });
    },
    [addToast]
  );

  const info = useCallback(
    (message: string, duration: number = DEFAULT_DURATION): string => {
      return addToast({ type: 'info', message, duration });
    },
    [addToast]
  );

  const clearAll = useCallback(() => {
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
    setToasts((prev) => prev.map((t) => ({ ...t, exiting: true })));
    setTimeout(() => {
      setToasts([]);
    }, EXIT_ANIMATION_DURATION);
  }, []);

  const contextValue: ToastContextValue = {
    toasts,
    addToast,
    removeToast,
    success,
    error,
    warning,
    info,
    clearAll,
  };

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      <ToastContainer toasts={toasts} removeToast={removeToast} />
    </ToastContext.Provider>
  );
}

// ── Hook ────────────────────────────────────────────────────────

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within a ToastProvider');
  }
  return ctx;
}

// ── Toast Container Component ──────────────────────────────────

interface ToastContainerProps {
  toasts: Toast[];
  removeToast: (id: string) => void;
}

const typeStyles: Record<ToastType, { bg: string; icon: string; border: string }> = {
  success: { bg: '#e8f5e9', icon: '✓', border: '#4caf50' },
  error: { bg: '#ffebee', icon: '✗', border: '#f44336' },
  warning: { bg: '#fff8e1', icon: '⚠', border: '#ff9800' },
  info: { bg: '#e3f2fd', icon: 'ℹ', border: '#2196f3' },
};

function ToastContainer({ toasts, removeToast }: ToastContainerProps) {
  return (
    <div
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 10000,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        pointerEvents: 'none',
      }}
    >
      {toasts.map((toast) => {
        const style = typeStyles[toast.type];
        return (
          <div
            key={toast.id}
            style={{
              pointerEvents: 'auto',
              minWidth: 300,
              maxWidth: 420,
              padding: '12px 16px',
              borderRadius: 8,
              background: style.bg,
              border: `1px solid ${style.border}`,
              borderLeft: `4px solid ${style.border}`,
              boxShadow: '0 4px 12px rgba(0,0,0,0.1)',
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              fontSize: 14,
              lineHeight: 1.4,
              color: '#333',
              animation: toast.exiting
                ? 'toastExit 0.3s ease-in forwards'
                : 'toastEnter 0.3s ease-out',
              opacity: toast.exiting ? 0 : 1,
              transform: toast.exiting ? 'translateX(100%)' : 'translateX(0)',
            }}
            role="alert"
          >
            <span style={{ fontWeight: 700, fontSize: 16, lineHeight: 1, flexShrink: 0 }}>
              {style.icon}
            </span>
            <span style={{ flex: 1, wordBreak: 'break-word' }}>{toast.message}</span>
            <button
              onClick={() => removeToast(toast.id)}
              style={{
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: 1,
                color: '#888',
                padding: 0,
                flexShrink: 0,
              }}
              aria-label="关闭通知"
            >
              ×
            </button>
          </div>
        );
      })}

      {/* Toast animation keyframes */}
      <style>{`
        @keyframes toastEnter {
          from {
            opacity: 0;
            transform: translateX(100%) scale(0.95);
          }
          to {
            opacity: 1;
            transform: translateX(0) scale(1);
          }
        }
        @keyframes toastExit {
          from {
            opacity: 1;
            transform: translateX(0) scale(1);
          }
          to {
            opacity: 0;
            transform: translateX(100%) scale(0.95);
          }
        }
      `}</style>
    </div>
  );
}
