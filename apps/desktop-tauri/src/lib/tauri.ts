import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useRef,
  useCallback,
  type ReactNode,
} from 'react';

// ── Capability Invocation ──────────────────────────────────────

export async function callCapability(
  method: string,
  params?: Record<string, unknown>
): Promise<unknown> {
  return invoke('invoke_capability', { method, params: params ?? null });
}

// ── Sidecar Status ─────────────────────────────────────────────

export async function getSidecarStatus(): Promise<{
  healthy: boolean;
  aiReady?: boolean;
}> {
  return invoke('get_sidecar_status');
}

// ── AI Methods ─────────────────────────────────────────────────

export async function startAiSession(
  sessionId: string,
  message: string
): Promise<{
  session_id: string;
  streaming: boolean;
}> {
  return invoke('start_ai_session', { sessionId, message });
}

export async function getDegradationState(): Promise<'full' | 'ai_offline' | 'critical'> {
  return invoke('get_degradation_state');
}

// ── Event Listeners ────────────────────────────────────────────

export function onSidecarEvent(callback: (event: string) => void): () => void {
  const unlisten = listen<string>('sidecar-event', (e) => {
    callback(e.payload);
  });
  return () => {
    unlisten.then((fn) => fn());
  };
}

export interface AiStreamChunk {
  type: string;
  session_id?: string;
  content?: string;
  approval_id?: string;
  capability_name?: string;
  mutating?: boolean;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: unknown;
  error?: string;
  usage?: { input_tokens: number; output_tokens: number };
  done?: boolean;
}

export function onAiStreamChunk(callback: (chunk: AiStreamChunk) => void): () => void {
  const unlisten = listen<AiStreamChunk>('ai-stream-chunk', (e) => {
    // The payload is already typed as AiStreamChunk by listen<T>
    const chunk = e.payload;
    // Validate we have a minimum viable chunk
    if (chunk && typeof chunk.type === 'string') {
      callback(chunk);
    } else {
      // Attempt to parse if shape is unexpected
      try {
        const parsed = typeof chunk === 'string' ? JSON.parse(chunk) : chunk;
        if (parsed && parsed.type) {
          callback(parsed as AiStreamChunk);
        }
      } catch {
        // Ignore malformed data
      }
    }
  });
  return () => {
    unlisten.then((fn) => fn());
  };
}

// ── Degradation State Context ──────────────────────────────────

type DegradationStateValue = 'full' | 'ai_offline' | 'critical';

const DegradationContext = createContext<DegradationStateValue>('full');

export function useDegradation(): DegradationStateValue {
  return useContext(DegradationContext);
}

export function useDegradationState(pollIntervalMs = 30000): {
  state: DegradationStateValue;
  startPolling: () => void;
  stopPolling: () => void;
} {
  const [state, setState] = useState<DegradationStateValue>('full');
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const result = await getDegradationState();
      setState(result);
    } catch {
      // Silently degrade — network errors mean something is wrong
    }
  }, []);

  const startPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      return;
    }
    poll(); // Immediate first poll
    intervalRef.current = setInterval(poll, pollIntervalMs);
  }, [poll, pollIntervalMs]);

  const stopPolling = useCallback(() => {
    if (intervalRef.current !== null) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
  }, []);

  useEffect(() => {
    return stopPolling;
  }, [stopPolling]);

  return { state, startPolling, stopPolling };
}

export function DegradationProvider({
  children,
  pollIntervalMs = 30000,
}: {
  children: ReactNode;
  pollIntervalMs?: number;
}) {
  const { state, startPolling } = useDegradationState(pollIntervalMs);

  useEffect(() => {
    startPolling();
  }, [startPolling]);

  return React.createElement(DegradationContext.Provider, { value: state }, children);
}
