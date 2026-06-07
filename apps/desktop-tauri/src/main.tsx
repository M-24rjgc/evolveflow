import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { AppStateProvider } from './store/useAppStore';
import { I18nProvider } from './lib/i18n';

// Sentry can be enabled by installing @sentry/react and setting VITE_SENTRY_DSN.
// Without it, AppErrorBoundary provides local error logging to localStorage.

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <AppStateProvider>
        <App />
      </AppStateProvider>
    </I18nProvider>
  </React.StrictMode>,
);
