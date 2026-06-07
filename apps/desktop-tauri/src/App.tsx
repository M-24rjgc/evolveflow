import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, useLocation, Link } from 'react-router-dom';
import TodayPage from './pages/TodayPage';
import CalendarPage from './pages/CalendarPage';
import TasksPage from './pages/TasksPage';
import AIPage from './pages/AIPage';
import SettingsPage from './pages/SettingsPage';
import AnalyticsPage from './pages/AnalyticsPage';
import GlobalAIFloating from './components/GlobalAIFloating';
import OnboardingFlow from './components/OnboardingFlow';
import AppErrorBoundary from './components/AppErrorBoundary';
import HelpPanel from './components/HelpPanel';
import { DegradationProvider, useDegradation, callCapability } from './lib/tauri';
import { useKeyboardShortcuts } from './lib/useKeyboardShortcuts';
import { useNavigate } from 'react-router-dom';
import { ToastProvider, useToast } from './components/Toast';
import { useI18n } from './lib/i18n';
import {
  BarChart3,
  Bot,
  CalendarDays,
  CircleHelp,
  ClipboardList,
  Database,
  Home,
  Settings,
  Sparkles,
} from 'lucide-react';
import './App.css';

function App() {
  const [showOnboarding, setShowOnboarding] = useState(false);

  useEffect(() => {
    const checkOnboarding = async () => {
      try {
        const onboarded = localStorage.getItem('evolveflow_onboarded');
        if (!onboarded) {
          setShowOnboarding(true);
        }
      } catch {
        setShowOnboarding(true);
      }
    };
    checkOnboarding();
  }, []);

  // ── Theme initialization ─────────────────────────────────────

  useEffect(() => {
    function applyTheme() {
      let theme: string | null = null;
      try {
        theme = localStorage.getItem('evolveflow_theme');
      } catch {
        // ignore
      }
      if (!theme) {
        try {
          const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          theme = prefersDark ? 'dark' : 'light';
        } catch {
          theme = 'light';
        }
      }
      document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
    }

    applyTheme();

    // Listen for OS-level theme changes
    let mq: MediaQueryList | null = null;
    try {
      mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => {
        // Only auto-switch if user hasn't set a preference
        let stored: string | null = null;
        try {
          stored = localStorage.getItem('evolveflow_theme');
        } catch {
          // Ignore localStorage access failures and keep the system theme.
        }
        if (!stored) {
          document.documentElement.setAttribute('data-theme', mq!.matches ? 'dark' : 'light');
        }
      };
      mq.addEventListener('change', handler);
      return () => mq?.removeEventListener('change', handler);
    } catch {
      return undefined;
    }
  }, []);

  return (
    <BrowserRouter>
      {showOnboarding && (
        <OnboardingFlow onComplete={() => {
          localStorage.setItem('evolveflow_onboarded', 'true');
          setShowOnboarding(false);
        }} />
      )}
      <DegradationProvider>
        <ToastProvider>
          <AppContent />
        </ToastProvider>
      </DegradationProvider>
    </BrowserRouter>
  );
}

function AppContent() {
  const location = useLocation();
  const degradationState = useDegradation();
  const navigate = useNavigate();
  const toast = useToast();
  const { t } = useI18n();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // Close sidebar on route change (mobile)
  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

  // Global keyboard shortcuts
  useKeyboardShortcuts(
    [
      {
        id: 'new_task',
        label: t('shortcuts.newTask'),
        key: 'n',
        ctrl: true,
        handler: () => navigate('/tasks'),
      },
      {
        id: 'toggle_ai_floating',
        label: t('shortcuts.toggleAi'),
        key: 'f',
        ctrl: true,
        shift: true,
        global: true,
        handler: () => {
          // Dispatch a custom event that GlobalAIFloating listens to
          window.dispatchEvent(new CustomEvent('toggle-ai-floating'));
        },
      },
      {
        id: 'undo',
        label: t('shortcuts.undo'),
        key: 'z',
        ctrl: true,
        handler: async () => {
          try {
            const result = await callCapability('history.list_actions', { limit: 1 }) as {
              success: boolean;
              data?: Array<{ id: string; capability: string }>;
            };
            if (result.success && result.data && result.data.length > 0) {
              const lastAction = result.data[0];
              const undoResult = await callCapability('undo.revert_action', { action_log_id: lastAction.id }) as {
                success: boolean;
                error?: string;
              };
              if (undoResult.success) {
                toast.success(t('toast.undoSuccess'));
              } else {
                toast.error(undoResult.error || t('toast.undoFailed'));
              }
            } else {
              toast.info(t('toast.noUndoable'));
            }
          } catch (err) {
            console.error('Undo failed:', err);
            toast.info(t('toast.undoInAi'));
          }
        },
      },
      {
        id: 'save_form',
        label: t('shortcuts.saveForm'),
        key: 's',
        ctrl: true,
        handler: () => {
          // Dispatch save event for active form
          window.dispatchEvent(new CustomEvent('form-save'));
        },
      },
      {
        id: 'tab_today',
        label: t('shortcuts.tabToday'),
        key: '1',
        handler: () => navigate('/'),
      },
      {
        id: 'tab_calendar',
        label: t('shortcuts.tabCalendar'),
        key: '2',
        handler: () => navigate('/calendar'),
      },
      {
        id: 'tab_tasks',
        label: t('shortcuts.tabTasks'),
        key: '3',
        handler: () => navigate('/tasks'),
      },
      {
        id: 'tab_ai',
        label: t('shortcuts.tabAi'),
        key: '4',
        handler: () => navigate('/ai'),
      },
      {
        id: 'tab_settings',
        label: t('shortcuts.tabSettings'),
        key: '5',
        handler: () => navigate('/settings'),
      },
    ],
    { enabled: true },
  );

  const showBanner = degradationState === 'critical' || degradationState === 'ai_offline';
  const bannerMessage = t('degradation.' + degradationState);
  const aiOffline = degradationState === 'ai_offline' || degradationState === 'critical';
  const navItems = [
    { to: '/', label: t('nav.today'), icon: Home, end: true },
    { to: '/calendar', label: t('nav.calendar'), icon: CalendarDays },
    { to: '/tasks', label: t('nav.tasks'), icon: ClipboardList },
    { to: '/ai', label: t('nav.ai'), icon: Bot },
    { to: '/analytics', label: t('nav.analytics'), icon: BarChart3 },
    { to: '/settings', label: t('nav.settings'), icon: Settings },
  ];

  return (
    <div className="app-layout">
      {showBanner && (
        <div className={`degradation-banner ${degradationState === 'critical' ? 'critical' : 'ai-offline'}`}
          style={showBanner ? { marginTop: 0 } : undefined}>
          <span>{degradationState === 'critical' ? '🔴' : '🟡'}</span>
          <span>{bannerMessage}</span>
        </div>
      )}

      {/* Hamburger button for mobile */}
      <button
        className={`hamburger-btn ${sidebarOpen ? 'open' : ''}`}
        onClick={() => setSidebarOpen(!sidebarOpen)}
        aria-label="Toggle navigation menu"
      >
        <span></span>
        <span></span>
        <span></span>
      </button>

      {/* Overlay for mobile sidebar */}
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      <nav className={`sidebar ${sidebarOpen ? 'open' : ''}`} aria-label={t('aria.main_nav')} role="navigation" style={showBanner ? { marginTop: 34 } : undefined}>
        <div className="logo">
          <span className="logo-mark"><Sparkles size={18} /></span>
          <span className="logo-text">EvolveFlow</span>
        </div>
        <div className="nav-links" role="menubar" aria-label={t('aria.page_nav')}>
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}
              end={end}
              role="menuitem"
            >
              <Icon size={18} />
              <span>{label}</span>
            </NavLink>
          ))}
        </div>
        <div className="sidebar-status">
          <div className="status-tile">
            <span className={`status-dot ${aiOffline ? 'warning' : ''}`} />
            <span>
              <strong>{aiOffline ? 'AI 服务离线' : 'AI 服务在线'}</strong>
              <span>{aiOffline ? '基础功能可用' : 'Agent 已待命'}</span>
            </span>
          </div>
          <div className="status-tile">
            <Database size={18} color="var(--accent-color)" />
            <span>
              <strong>本地数据</strong>
              <span>SQLite · 可备份</span>
            </span>
          </div>
          <button
            className="btn btn-secondary"
            onClick={() => setHelpOpen(true)}
            aria-label={t('aria.help_center')}
            style={{
              width: '100%',
              textAlign: 'center',
              minHeight: 42,
            }}
          >
            <CircleHelp size={16} />
            <span>{t('help.title')}</span>
          </button>
        </div>
      </nav>
      <main className="main-content" aria-label={t('aria.main_content')} style={showBanner ? { marginTop: 34 } : undefined}>
        <AppErrorBoundary>
          <Routes>
            <Route path="/" element={<TodayPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/ai" element={<AIPage />} />
            <Route path="/analytics" element={<AnalyticsPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </AppErrorBoundary>
      </main>
      <GlobalAIFloating currentPage={location.pathname} />
      <HelpPanel isOpen={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

function NotFound() {
  const { t } = useI18n();
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '50vh',
      gap: 16,
    }}>
      <h1 style={{ fontSize: 64, color: 'var(--text-muted)', margin: 0 }}>{t('notFound.title')}</h1>
      <p style={{ fontSize: 18, color: 'var(--text-muted)' }}>{t('notFound.message')}</p>
      <p style={{ fontSize: 14, color: 'var(--text-disabled)' }}>
        {t('notFound.description')}
      </p>
      <Link to="/" className="btn btn-primary" style={{ textDecoration: 'none' }}>
        {t('notFound.back_home')}
      </Link>
    </div>
  );
}

export default App;
