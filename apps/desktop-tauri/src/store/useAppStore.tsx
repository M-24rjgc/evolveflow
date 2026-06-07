import React, { createContext, useContext, useReducer, useCallback, useEffect, useRef, type ReactNode } from 'react';
import { callCapability } from '../lib/tauri';

// ── Types ──────────────────────────────────────────────────────

export interface Task {
  id: string;
  title: string;
  description?: string;
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

export interface CalendarEvent {
  id: string;
  title: string;
  description?: string;
  start_time: string;
  end_time: string;
  locked: boolean;
  bound_task_id: string | null;
}

export interface ScheduleBlock {
  id: string;
  task_id: string | null;
  event_id: string | null;
  date: string;
  start_time: string;
  end_time: string;
  locked: boolean;
}

export interface Reminder {
  id: string;
  task_id: string | null;
  event_id: string | null;
  trigger_at: string;
  message: string | null;
  status: string;
}

export type AiStatusValue = 'checking' | 'ready' | 'no_key' | 'offline';
export type DegradationStateValue = 'full' | 'ai_offline' | 'critical';
export type BuddyLevelValue = 'full' | 'minimal' | 'off';

// ── Store Shape ─────────────────────────────────────────────────

export interface AppState {
  tasks: Task[];
  events: CalendarEvent[];
  schedule: ScheduleBlock[];
  reminders: Reminder[];
  aiStatus: AiStatusValue;
  degradationState: DegradationStateValue;
  buddyLevel: BuddyLevelValue;
  lastFetchTimestamp: number;
}

const initialState: AppState = {
  tasks: [],
  events: [],
  schedule: [],
  reminders: [],
  aiStatus: 'checking',
  degradationState: 'full',
  buddyLevel: 'full',
  lastFetchTimestamp: 0,
};

// ── Actions ─────────────────────────────────────────────────────

type Action =
  | { type: 'SET_TASKS'; payload: Task[] }
  | { type: 'ADD_TASK'; payload: Task }
  | { type: 'UPDATE_TASK'; payload: Partial<Task> & { id: string } }
  | { type: 'REMOVE_TASK'; payload: string }
  | { type: 'SET_EVENTS'; payload: CalendarEvent[] }
  | { type: 'SET_SCHEDULE'; payload: ScheduleBlock[] }
  | { type: 'SET_REMINDERS'; payload: Reminder[] }
  | { type: 'SET_AI_STATUS'; payload: AiStatusValue }
  | { type: 'SET_DEGRADATION_STATE'; payload: DegradationStateValue }
  | { type: 'SET_BUDDY_LEVEL'; payload: BuddyLevelValue }
  | { type: 'SET_LAST_FETCH'; payload: number };

function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_TASKS':
      return { ...state, tasks: action.payload };
    case 'ADD_TASK':
      return { ...state, tasks: [...state.tasks, action.payload] };
    case 'UPDATE_TASK':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === action.payload.id ? { ...t, ...action.payload } : t
        ),
      };
    case 'REMOVE_TASK':
      return { ...state, tasks: state.tasks.filter((t) => t.id !== action.payload) };
    case 'SET_EVENTS':
      return { ...state, events: action.payload };
    case 'SET_SCHEDULE':
      return { ...state, schedule: action.payload };
    case 'SET_REMINDERS':
      return { ...state, reminders: action.payload };
    case 'SET_AI_STATUS':
      return { ...state, aiStatus: action.payload };
    case 'SET_DEGRADATION_STATE':
      return { ...state, degradationState: action.payload };
    case 'SET_BUDDY_LEVEL':
      return { ...state, buddyLevel: action.payload };
    case 'SET_LAST_FETCH':
      return { ...state, lastFetchTimestamp: action.payload };
    default:
      return state;
  }
}

// ── Context ─────────────────────────────────────────────────────

interface AppStoreContextValue {
  state: AppState;
  dispatch: React.Dispatch<Action>;
  // Convenience action creators
  setTasks: (tasks: Task[]) => void;
  addTask: (task: Task) => void;
  updateTask: (task: Partial<Task> & { id: string }) => void;
  removeTask: (id: string) => void;
  setEvents: (events: CalendarEvent[]) => void;
  setSchedule: (schedule: ScheduleBlock[]) => void;
  setReminders: (reminders: Reminder[]) => void;
  setAiStatus: (status: AiStatusValue) => void;
  setDegradationState: (state: DegradationStateValue) => void;
  setBuddyLevel: (level: BuddyLevelValue) => void;
  refreshAll: () => Promise<void>;
}

const AppStoreContext = createContext<AppStoreContextValue | null>(null);

// ── Cache TTL ───────────────────────────────────────────────────

const CACHE_TTL_MS = 30000; // 30 seconds

// ── Provider ────────────────────────────────────────────────────

export function AppStateProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setTasks = useCallback((tasks: Task[]) => {
    dispatch({ type: 'SET_TASKS', payload: tasks });
  }, []);

  const addTask = useCallback((task: Task) => {
    dispatch({ type: 'ADD_TASK', payload: task });
  }, []);

  const updateTask = useCallback((task: Partial<Task> & { id: string }) => {
    dispatch({ type: 'UPDATE_TASK', payload: task });
  }, []);

  const removeTask = useCallback((id: string) => {
    dispatch({ type: 'REMOVE_TASK', payload: id });
  }, []);

  const setEvents = useCallback((events: CalendarEvent[]) => {
    dispatch({ type: 'SET_EVENTS', payload: events });
  }, []);

  const setSchedule = useCallback((schedule: ScheduleBlock[]) => {
    dispatch({ type: 'SET_SCHEDULE', payload: schedule });
  }, []);

  const setReminders = useCallback((reminders: Reminder[]) => {
    dispatch({ type: 'SET_REMINDERS', payload: reminders });
  }, []);

  const setAiStatus = useCallback((status: AiStatusValue) => {
    dispatch({ type: 'SET_AI_STATUS', payload: status });
  }, []);

  const setDegradationState = useCallback((degState: DegradationStateValue) => {
    dispatch({ type: 'SET_DEGRADATION_STATE', payload: degState });
  }, []);

  const setBuddyLevel = useCallback((level: BuddyLevelValue) => {
    dispatch({ type: 'SET_BUDDY_LEVEL', payload: level });
  }, []);

  const refreshAll = useCallback(async () => {
    if (loadingRef.current) {return;}
    loadingRef.current = true;

    const now = Date.now();
    // Check cache validity
    if (now - state.lastFetchTimestamp < CACHE_TTL_MS && state.tasks.length > 0) {
      loadingRef.current = false;
      return;
    }

    try {
      const today = new Date().toISOString().split('T')[0];
      const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

      const [taskResult, eventResult, remResult, aiStatusResult, buddyResult] =
        await Promise.allSettled([
          callCapability('task.list', {}) as Promise<{ success: boolean; data?: Task[] }>,
          callCapability('event.list', {
            start: `${today}T00:00:00`,
            end: `${tomorrow}T23:59:59`,
          }) as Promise<{ success: boolean; data?: CalendarEvent[] }>,
          callCapability('reminder.list', {}) as Promise<{ success: boolean; data?: Reminder[] }>,
          callCapability('ai.check_connectivity', {}) as Promise<{ connected?: boolean; reason?: string }>,
          callCapability('preference.get', { key: 'buddy_level' }) as Promise<{ success: boolean; data?: string }>,
        ]);

      if (mountedRef.current) {
        // Tasks
        if (taskResult.status === 'fulfilled' && taskResult.value.success && taskResult.value.data) {
          dispatch({ type: 'SET_TASKS', payload: taskResult.value.data });
        }

        // Events
        if (eventResult.status === 'fulfilled' && eventResult.value.success && eventResult.value.data) {
          dispatch({ type: 'SET_EVENTS', payload: eventResult.value.data });
        }

        // Reminders
        if (remResult.status === 'fulfilled' && remResult.value.success && remResult.value.data) {
          dispatch({ type: 'SET_REMINDERS', payload: remResult.value.data });
        }

        // AI status
        if (aiStatusResult.status === 'fulfilled') {
          const aiData = aiStatusResult.value as { connected?: boolean; reason?: string };
          if (aiData.connected) {
            dispatch({ type: 'SET_AI_STATUS', payload: 'ready' });
          } else if (aiData.reason?.includes('not initialized')) {
            dispatch({ type: 'SET_AI_STATUS', payload: 'no_key' });
          } else {
            dispatch({ type: 'SET_AI_STATUS', payload: 'offline' });
          }
        }

        // Buddy level
        if (buddyResult.status === 'fulfilled' && buddyResult.value.success && buddyResult.value.data) {
          dispatch({
            type: 'SET_BUDDY_LEVEL',
            payload: buddyResult.value.data as BuddyLevelValue,
          });
        }

        dispatch({ type: 'SET_LAST_FETCH', payload: now });
      }
    } catch {
      // Silently handle errors — individual pages can retry
    } finally {
      loadingRef.current = false;
    }
  }, [state.lastFetchTimestamp, state.tasks.length]);

  const contextValue: AppStoreContextValue = {
    state,
    dispatch,
    setTasks,
    addTask,
    updateTask,
    removeTask,
    setEvents,
    setSchedule,
    setReminders,
    setAiStatus,
    setDegradationState,
    setBuddyLevel,
    refreshAll,
  };

  return (
    <AppStoreContext.Provider value={contextValue}>
      {children}
    </AppStoreContext.Provider>
  );
}

// ── Hook ────────────────────────────────────────────────────────

export function useAppState(): AppStoreContextValue {
  const ctx = useContext(AppStoreContext);
  if (!ctx) {
    throw new Error('useAppState must be used within an AppStateProvider');
  }
  return ctx;
}

// ── Data Refresh Hook ──────────────────────────────────────────

/**
 * A hook that automatically refreshes all data on mount and at intervals.
 * Respects the 30-second cache TTL and deduplicates concurrent refreshes.
 */
export function useDataRefresh(
  intervalMs: number = 60000,
  immediate: boolean = true,
): { isRefreshing: boolean; lastRefreshed: number | null } {
  const { refreshAll, state } = useAppState();
  const [isRefreshing, setIsRefreshing] = React.useState(false);
  const [lastRefreshed, setLastRefreshed] = React.useState<number | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const doRefresh = useCallback(async () => {
    setIsRefreshing(true);
    try {
      await refreshAll();
      setLastRefreshed(Date.now());
    } finally {
      setIsRefreshing(false);
    }
  }, [refreshAll]);

  useEffect(() => {
    if (immediate) {
      doRefresh();
    }

    intervalRef.current = setInterval(doRefresh, intervalMs);

    return () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [doRefresh, intervalMs, immediate]);

  return { isRefreshing, lastRefreshed };
}

/**
 * Hook that provides cache-invalidation helpers.
 * Call `invalidateCache()` to force the next refresh to bypass TTL.
 */
export function useCacheInvalidation(): { invalidateCache: () => void; lastFetchTimestamp: number } {
  const { dispatch, state } = useAppState();

  const invalidateCache = useCallback(() => {
    dispatch({ type: 'SET_LAST_FETCH', payload: 0 });
  }, [dispatch]);

  return { invalidateCache, lastFetchTimestamp: state.lastFetchTimestamp };
}
