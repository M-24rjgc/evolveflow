import React, { useState, useEffect } from 'react';
import { BrowserRouter, Routes, Route, NavLink, useLocation } from 'react-router-dom';
import TodayPage from './pages/TodayPage';
import CalendarPage from './pages/CalendarPage';
import TasksPage from './pages/TasksPage';
import AIPage from './pages/AIPage';
import SettingsPage from './pages/SettingsPage';
import GlobalAIFloating from './components/GlobalAIFloating';
import OnboardingFlow from './components/OnboardingFlow';
import AppErrorBoundary from './components/AppErrorBoundary';
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

  return (
    <BrowserRouter>
      {showOnboarding && (
        <OnboardingFlow onComplete={() => {
          localStorage.setItem('evolveflow_onboarded', 'true');
          setShowOnboarding(false);
        }} />
      )}
      <AppContent />
    </BrowserRouter>
  );
}

function AppContent() {
  const location = useLocation();

  return (
    <div className="app-layout">
      <nav className="sidebar">
        <div className="logo">EvolveFlow</div>
        <div className="nav-links">
          <NavLink to="/" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'} end>今天</NavLink>
          <NavLink to="/calendar" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>日历</NavLink>
          <NavLink to="/tasks" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>任务</NavLink>
          <NavLink to="/ai" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>AI</NavLink>
          <NavLink to="/settings" className={({ isActive }) => isActive ? 'nav-item active' : 'nav-item'}>设置</NavLink>
        </div>
      </nav>
      <main className="main-content">
        <AppErrorBoundary>
          <Routes>
            <Route path="/" element={<TodayPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/ai" element={<AIPage />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Routes>
        </AppErrorBoundary>
      </main>
      <GlobalAIFloating currentPage={location.pathname} />
    </div>
  );
}

export default App;
