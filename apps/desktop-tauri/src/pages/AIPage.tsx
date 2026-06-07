import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  Bot,
  Brain,
  CircleAlert,
  CircleCheck,
  Database,
  History,
  KeyRound,
  Layers,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  TerminalSquare,
  Wand2,
  WifiOff,
} from 'lucide-react';
import { callCapability, onAiStreamChunk, onSidecarEvent, type AiStreamChunk } from '../lib/tauri';
import { useI18n } from '../lib/i18n';
import { EmptyPanel, MetricCard, PageHeader, PageShell, Panel } from '../components/PageChrome';

// ── Types ──────────────────────────────────────────────────────

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  thinking?: string;
  toolCalls?: ToolCallRecord[];
  timestamp: number;
  isStreaming?: boolean;
}

interface ToolCallRecord {
  toolUseId: string;
  toolName: string;
  toolInput?: Record<string, unknown>;
  toolResult?: unknown;
  status: 'pending' | 'running' | 'done' | 'error';
  error?: string;
}

interface ActionLog {
  id: string;
  capability: string;
  actor: string;
  origin: string;
  description: string | null;
  created_at: string;
}

interface DreamStatus {
  isRunning: boolean;
  lastDreamTime: string | null;
  sessionCount: number;
}

// ── Constants ───────────────────────────────────────────────────

const STREAM_TIMEOUT_MS = 30000;
const MESSAGES_STORAGE_PREFIX = 'evolveflow_ai_messages_';
const MAX_STORED_MESSAGES = 100;
const CHECK_INTERVAL_MS = 5000;

// ── Lightweight Markdown Renderer ───────────────────────────────

// Top-level: split content by code blocks first, then newlines, then inline formatting
function renderMessageContent(content: string): React.ReactNode[] {
  const codeBlockRegex = /```(\w*)\n?([\s\S]*?)```/g;
  const segments: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(content)) !== null) {
    // Render text before this code block (handle newlines and inline formatting)
    if (match.index > lastIndex) {
      segments.push(renderNewlinesAndInline(content.slice(lastIndex, match.index)));
    }
    const language = match[1] || '';
    const code = match[2] || '';
    segments.push(
      <pre
        key={`cb-${match.index}`}
        style={{
          background: '#1e1e1e',
          color: '#d4d4d4',
          padding: '12px 16px',
          borderRadius: 6,
          overflowX: 'auto',
          fontFamily: "'Fira Code', 'Cascadia Code', 'JetBrains Mono', Consolas, monospace",
          fontSize: 12,
          lineHeight: 1.5,
          margin: '8px 0',
        }}
      >
        {language && (
          <div style={{ fontSize: 10, color: '#888', marginBottom: 4, textTransform: 'uppercase', letterSpacing: 1 }}>
            {language}
          </div>
        )}
        <code>{code}</code>
      </pre>
    );
    lastIndex = match.index + match[0].length;
  }

  // Push remaining text after last code block
  if (lastIndex < content.length) {
    segments.push(renderNewlinesAndInline(content.slice(lastIndex)));
  }

  return segments.length > 0 ? segments : [renderNewlinesAndInline(content)];
}

// Handle newlines within a non-code-block text segment
function renderNewlinesAndInline(text: string): React.ReactNode {
  const lines = text.split('\n');
  const elements: React.ReactNode[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (i > 0) {elements.push(<br key={`br-${i}`} />);}
    const line = lines[i];
    if (line.trim() === '') {
      elements.push(<br key={`br-empty-${i}`} />);
    } else {
      elements.push(
        <React.Fragment key={`l-${i}`}>
          {renderInlineFormatting(line)}
        </React.Fragment>
      );
    }
  }

  return <>{elements}</>;
}

// Handle inline formatting: `code`, **bold**, *italic*
function renderInlineFormatting(text: string): React.ReactNode {
  // First split by inline code (`code`)
  const codeSplit = text.split(/(`[^`]+`)/g);
  const parts: React.ReactNode[] = [];

  for (let i = 0; i < codeSplit.length; i++) {
    const segment = codeSplit[i];
    if (segment.startsWith('`') && segment.endsWith('`')) {
      parts.push(
        <code
          key={`ic-${i}`}
          style={{
            background: '#f0f0f0',
            padding: '2px 6px',
            borderRadius: 3,
            fontFamily: 'Consolas, monospace',
            fontSize: '0.9em',
            color: '#e83e8c',
          }}
        >
          {segment.slice(1, -1)}
        </code>
      );
    } else {
      // Parse bold and italic
      parts.push(renderBoldItalic(segment, `fmt-${i}`));
    }
  }

  return <>{parts}</>;
}

function renderBoldItalic(text: string, keyPrefix: string): React.ReactNode {
  // Handle **bold** first, then *italic* within non-bold spans
  const boldParts: React.ReactNode[] = [];
  const boldRegex = /\*\*(.+?)\*\*/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  while ((m = boldRegex.exec(text)) !== null) {
    if (m.index > lastIdx) {
      boldParts.push(renderItalicOnly(text.slice(lastIdx, m.index), `${keyPrefix}-bi-${lastIdx}`));
    }
    boldParts.push(
      <strong key={`${keyPrefix}-bold-${m.index}`}>{renderItalicOnly(m[1], `${keyPrefix}-b-${m.index}`)}</strong>
    );
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    boldParts.push(renderItalicOnly(text.slice(lastIdx), `${keyPrefix}-bi-rem-${lastIdx}`));
  }

  return <>{boldParts}</>;
}

function renderItalicOnly(text: string, keyPrefix: string): React.ReactNode {
  const parts: React.ReactNode[] = [];
  const italicRegex = /\*(.+?)\*/g;
  let lastIdx = 0;
  let m: RegExpExecArray | null;

  while ((m = italicRegex.exec(text)) !== null) {
    if (m.index > lastIdx) {
      parts.push(<span key={`${keyPrefix}-t-${lastIdx}`}>{text.slice(lastIdx, m.index)}</span>);
    }
    parts.push(<em key={`${keyPrefix}-em-${m.index}`}>{m[1]}</em>);
    lastIdx = m.index + m[0].length;
  }
  if (lastIdx < text.length) {
    parts.push(<span key={`${keyPrefix}-t-rem-${lastIdx}`}>{text.slice(lastIdx)}</span>);
  }

  return parts.length > 0 ? <>{parts}</> : text;
}

// ── Helper Functions ────────────────────────────────────────────

function loadMessages(sessionId: string): ChatMessage[] {
  try {
    const saved = localStorage.getItem(`${MESSAGES_STORAGE_PREFIX}${sessionId}`);
    if (saved) {
      const parsed = JSON.parse(saved) as ChatMessage[];
      if (Array.isArray(parsed) && parsed.length > 0) {return parsed;}
    }
  } catch {
    // Corrupted data, ignore
  }
  return [];
}

function saveMessages(sessionId: string, messages: ChatMessage[]) {
  try {
    const toSave = messages.slice(-MAX_STORED_MESSAGES);
    localStorage.setItem(`${MESSAGES_STORAGE_PREFIX}${sessionId}`, JSON.stringify(toSave));
  } catch {
    // Storage quota exceeded, silently fail
  }
}

// ── Component ──────────────────────────────────────────────────

export default function AIPage() {
  const { t, locale } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      content: t('ai.welcome'),
      timestamp: Date.now(),
    },
  ]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [aiStatus, setAiStatus] = useState<'checking' | 'ready' | 'no_key' | 'offline'>('checking');
  const [actionLogs, setActionLogs] = useState<ActionLog[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [dreamStatus, setDreamStatus] = useState<DreamStatus | null>(null);
  const [showContext, setShowContext] = useState(false);
  const [contextData, setContextData] = useState<Record<string, unknown> | null>(null);
  const [tokenUsage, setTokenUsage] = useState<{ input: number; output: number }>({ input: 0, output: 0 });
  const [streamError, setStreamError] = useState<string | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const lastChunkTimeRef = useRef<number>(Date.now());
  const initializedRef = useRef(false);

  // ── Throttled Stream Batching ─────────────────────────────────
  // Only flush accumulated chunk content to React state at most once
  // per 50ms.  Uses requestAnimationFrame alignment to avoid visual
  // jank and coalesce rapid chunk bursts.
  const pendingChunksRef = useRef<AiStreamChunk[]>([]);
  const rafIdRef = useRef<number | null>(null);

  const flushPendingChunks = useCallback(() => {
    rafIdRef.current = null;
    const chunks = pendingChunksRef.current.slice();
    pendingChunksRef.current = [];

    if (!mountedRef.current || chunks.length === 0) {return;}

    setMessages((prev) => {
      const updated = [...prev];
      for (const chunk of chunks) {
        const lastMsg = updated[updated.length - 1];
        switch (chunk.type) {
          case 'session_start': {
            const newMsg: ChatMessage = {
              id: `ai_${Date.now()}`,
              role: 'assistant',
              content: '',
              thinking: '',
              toolCalls: [],
              timestamp: Date.now(),
              isStreaming: true,
            };
            updated.push(newMsg);
            break;
          }
          case 'thinking_delta': {
            if (lastMsg && lastMsg.isStreaming) {
              lastMsg.thinking = (lastMsg.thinking || '') + (chunk.content || '');
            }
            break;
          }
          case 'text_delta': {
            if (lastMsg && lastMsg.isStreaming) {
              lastMsg.content += chunk.content || '';
            }
            break;
          }
          case 'tool_use_start': {
            if (lastMsg && lastMsg.isStreaming) {
              if (!lastMsg.toolCalls) {lastMsg.toolCalls = [];}
              lastMsg.toolCalls.push({
                toolUseId: chunk.tool_use_id || '',
                toolName: chunk.tool_name || 'unknown',
                toolInput: chunk.tool_input,
                status: 'running',
              });
            }
            break;
          }
          case 'tool_result': {
            if (lastMsg && lastMsg.toolCalls) {
              const tc = lastMsg.toolCalls.find(
                (t) => t.toolUseId === chunk.tool_use_id,
              );
              if (tc) {
                tc.toolResult = chunk.tool_result || chunk.error;
                tc.status = chunk.error ? 'error' : 'done';
                tc.error = chunk.error;
              }
            }
            break;
          }
          case 'done': {
            if (lastMsg && lastMsg.isStreaming) {
              lastMsg.isStreaming = false;
              lastMsg.timestamp = Date.now();
            }
            setIsStreaming(false);
            if (chunk.usage) {
              setTokenUsage((prev) => ({
                input: prev.input + (chunk.usage?.input_tokens || 0),
                output: prev.output + (chunk.usage?.output_tokens || 0),
              }));
            }
            loadActionLogs();
            loadContext();
            break;
          }
          case 'error': {
            if (lastMsg && lastMsg.isStreaming) {
              lastMsg.content += `\n\n❌ ${t('ai.error_prefix')}: ${chunk.error || t('ai.unknown_error')}`;
              lastMsg.isStreaming = false;
            }
            setIsStreaming(false);
            break;
          }
        }
      }
      return updated;
    });
  }, []);

  // ── Lifecycle ────────────────────────────────────────────────

  useEffect(() => {
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    checkAiStatus();
    loadActionLogs();
    checkDreamStatus();
    loadContext();

    // Use dedicated onAiStreamChunk for AI events
    const unsubStream = onAiStreamChunk((chunk: AiStreamChunk) => {
      if (!mountedRef.current) {return;}
      lastChunkTimeRef.current = Date.now();
      setStreamError(null);
      handleStreamChunk(chunk);
    });

    // Use onSidecarEvent only for non-AI events (e.g., sidecar lifecycle)
    const unsubSidecar = onSidecarEvent((eventStr: string) => {
      try {
        const event = JSON.parse(eventStr);
        if (event.type === 'sidecar.health' || event.type === 'sidecar.started' || event.type === 'sidecar.stopped') {
          // Handle sidecar lifecycle events here
        }
      } catch {
        // Ignore parse errors for sidecar events
      }
    });

    // Load saved messages
    const sessionId = `session_${Date.now()}`;
    setCurrentSessionId(sessionId);
    const saved = loadMessages(sessionId);
    if (saved.length > 0) {
      setMessages(saved);
    }

    return () => {
      unsubStream();
      unsubSidecar();
    };
  }, []);

  // Save messages to localStorage when they change
  useEffect(() => {
    if (currentSessionId && !initializedRef.current) {
      initializedRef.current = true;
      return;
    }
    if (currentSessionId && messages.length > 0) {
      saveMessages(currentSessionId, messages);
    }
  }, [messages, currentSessionId]);

  // Streaming timeout check
  useEffect(() => {
    if (!isStreaming) {return;}

    const interval = setInterval(() => {
      if (!mountedRef.current) {return;}
      const elapsed = Date.now() - lastChunkTimeRef.current;
      if (elapsed > STREAM_TIMEOUT_MS) {
        console.warn('AI stream timed out after 30s of inactivity');
        setIsStreaming(false);
        setStreamError(t('ai.stream_error'));
        // Mark last message as not streaming
        setMessages((prev) => {
          const updated = [...prev];
          const last = updated[updated.length - 1];
          if (last && last.isStreaming) {
            last.isStreaming = false;
            last.content += `\n\n_${t('ai.stream_error')}_`;
          }
          return updated;
        });
      }
    }, CHECK_INTERVAL_MS);

    return () => clearInterval(interval);
  }, [isStreaming]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // ── AI Status ────────────────────────────────────────────────

  async function checkAiStatus() {
    try {
      const result = await callCapability('ai.check_connectivity', {}) as { connected?: boolean; reason?: string };
      if (result.connected) {
        setAiStatus('ready');
      } else if (result.reason?.includes('not initialized')) {
        setAiStatus('no_key');
      } else {
        setAiStatus('offline');
      }
    } catch {
      setAiStatus('no_key');
    }
  }

  // ── Streaming Handler ────────────────────────────────────────

  const handleStreamChunk = useCallback((chunk: AiStreamChunk) => {
    if (!mountedRef.current) {return;}

    // Enqueue the chunk for batched processing (throttled to max ~1 render per 50ms)
    pendingChunksRef.current.push(chunk);

    if (rafIdRef.current === null) {
      rafIdRef.current = requestAnimationFrame(() => {
        flushPendingChunks();
      });
    }

    // For terminal chunks (done/error), flush immediately so the UI is responsive.
    if (chunk.type === 'done' || chunk.type === 'error') {
      if (rafIdRef.current !== null) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = null;
      }
      // Also flush any accumulated text/thinking chunks synchronously.
      flushPendingChunks();
      // Direct handling for done/error to ensure the streaming flag updates promptly.
      if (chunk.type === 'done') {
        setIsStreaming(false);
        if (chunk.usage) {
          setTokenUsage((prev) => ({
            input: prev.input + (chunk.usage?.input_tokens || 0),
            output: prev.output + (chunk.usage?.output_tokens || 0),
          }));
        }
        loadActionLogs();
        loadContext();
      } else if (chunk.type === 'error') {
        setIsStreaming(false);
      }
    }
  }, [flushPendingChunks]);

  // ── Send Message ─────────────────────────────────────────────

  async function handleSend() {
    if (!input.trim() || isStreaming) {return;}

    const userMsg = input.trim();
    const sessionId = currentSessionId || `session_${Date.now()}`;

    if (!currentSessionId) {
      setCurrentSessionId(sessionId);
    }

    const userMessage: ChatMessage = {
      id: `user_${Date.now()}`,
      role: 'user',
      content: userMsg,
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, userMessage]);
    setInput('');
    setIsStreaming(true);
    setStreamError(null);
    lastChunkTimeRef.current = Date.now();

    try {
      const result = await callCapability('ai.stream', {
        message: userMsg,
        session_id: sessionId,
      }) as { session_id?: string; streaming?: boolean };

      if (!result.streaming) {
        // Fallback to non-streaming
        const fallback = await callCapability('ai.chat', {
          message: userMsg,
          session_id: sessionId,
        }) as { text?: string; error?: string; session_id?: string };

        const text = fallback.text;
        if (text) {
          setMessages((prev) => [
            ...prev,
            {
              id: `ai_${Date.now()}`,
              role: 'assistant' as const,
              content: text,
              timestamp: Date.now(),
            },
          ]);
        }
        if (fallback.error) {
          setMessages((prev) => [
            ...prev,
            {
              id: `err_${Date.now()}`,
              role: 'system',
              content: t('ai.error_format', { message: fallback.error || '' }),
              timestamp: Date.now(),
            },
          ]);
        }
        setIsStreaming(false);
        loadActionLogs();
        loadContext();
      }
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: `err_${Date.now()}`,
          role: 'system',
          content: `${t('ai.request_failed')}: ${err instanceof Error ? err.message : String(err)}`,
          timestamp: Date.now(),
        },
      ]);
      setIsStreaming(false);
    }
  }

  // ── Stop Generation ──────────────────────────────────────────

  async function handleStopGeneration() {
    try {
      await callCapability('ai.cancel_stream', { session_id: currentSessionId });
    } catch {
      // Best-effort cancellation
    }
    setIsStreaming(false);
    setMessages((prev) => {
      const updated = [...prev];
      const last = updated[updated.length - 1];
      if (last && last.isStreaming) {
        last.isStreaming = false;
        last.content += `\n\n_${t('ai.streaming_stopped')}_`;
      }
      return updated;
    });
  }

  // ── Data Loading ─────────────────────────────────────────────

  async function loadActionLogs() {
    try {
      const result = await callCapability('history.list_actions', { limit: 50 }) as {
        success: boolean;
        data?: ActionLog[];
      };
      if (result.success && result.data) {
        setActionLogs(result.data);
      }
    } catch {
      // silent
    }
  }

  async function checkDreamStatus() {
    try {
      const result = await callCapability('dream.status', {}) as DreamStatus;
      setDreamStatus(result);
    } catch {
      setDreamStatus({ isRunning: false, lastDreamTime: null, sessionCount: 0 });
    }
  }

  async function loadContext() {
    try {
      const result = await callCapability('ai.get_context', {}) as ConversationContext;
      if (result && result.currentDate) {
        setContextData(result as unknown as Record<string, unknown>);
      }
    } catch {
      // context not available
    }
  }

  // ── Actions ──────────────────────────────────────────────────

  function scrollToBottom() {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }

  function clearSession() {
    if (currentSessionId) {
      callCapability('ai.delete_session', { session_id: currentSessionId }).catch(() => {});
      localStorage.removeItem(`${MESSAGES_STORAGE_PREFIX}${currentSessionId}`);
    }
    setMessages([
      {
        id: 'welcome',
        role: 'assistant',
        content: t('ai.session_cleared'),
        timestamp: Date.now(),
      },
    ]);
    const newSessionId = `session_${Date.now()}`;
    setCurrentSessionId(newSessionId);
    setTokenUsage({ input: 0, output: 0 });
    initializedRef.current = false;
  }

  async function handleQuickAction(action: string) {
    setInput(action);
    inputRef.current?.focus();
  }

  // ── Render Helpers ───────────────────────────────────────────

  function formatToolName(name: string): string {
    const key = `ai.tool_names.${name}`;
    const translated = t(key as any);
    return translated !== key ? translated : name;
  }

  function formatTimestamp(ts: number): string {
    return new Date(ts).toLocaleTimeString(locale, {
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function statusBadge() {
    if (aiStatus === 'checking') {
      return <span className="status-badge"><RefreshCw size={13} />{t('ai.check_connection')}</span>;
    }
    if (aiStatus === 'ready') {
      return <span className="status-badge good"><CircleCheck size={13} />{t('ai.ready')}</span>;
    }
    if (aiStatus === 'no_key') {
      return <span className="status-badge warn"><KeyRound size={13} />{t('ai.no_key')}</span>;
    }
    return <span className="status-badge danger"><WifiOff size={13} />{t('ai.offline')}</span>;
  }

  // ── Render ───────────────────────────────────────────────────

  return (
    <PageShell className="ai-page-shell">
      <PageHeader
        title={t('ai.title')}
        subtitle={currentSessionId || t('ai.new_session')}
        icon={<Bot size={19} />}
        actions={
          <>
            {statusBadge()}
            {(tokenUsage.input > 0 || tokenUsage.output > 0) && (
              <span className="status-badge">
                <Sparkles size={13} />
                {t('ai.token_label')}: {(tokenUsage.input + tokenUsage.output).toLocaleString()}
              </span>
            )}
          <button
            className="btn btn-secondary"
            onClick={() => setShowContext(!showContext)}
          >
            <Layers size={15} />
            {showContext ? t('ai.hide_context') : t('ai.show_context')}
          </button>
          <button
            className="btn btn-secondary"
            onClick={() => { loadActionLogs(); setShowLogs(!showLogs); }}
          >
            <History size={15} />
            {showLogs ? t('ai.hide_history') : t('ai.action_history')}
          </button>
          <button
            className="btn btn-secondary"
            onClick={clearSession}
            aria-label={t('ai.new_session')}
          >
            <Plus size={15} />
            {t('ai.new_session')}
          </button>
          </>
        }
      />

      <div className="metric-grid">
        <MetricCard label={t('ai.ready')} value={aiStatus === 'ready' ? t('analytics.status_good') : aiStatus === 'checking' ? '...' : t('ai.offline')} hint={t('ai.check_connection')} tone={aiStatus === 'ready' ? 'good' : aiStatus === 'checking' ? undefined : 'warn'} />
        <MetricCard label={t('ai.dream_label')} value={dreamStatus?.sessionCount ?? 0} hint={dreamStatus?.lastDreamTime ? t('ai.dream_last_run', { time: new Date(dreamStatus.lastDreamTime).toLocaleString(locale) }) : t('ai.dream_never_run')} />
        <MetricCard label={t('ai.token_label')} value={(tokenUsage.input + tokenUsage.output).toLocaleString()} hint={`${tokenUsage.input} / ${tokenUsage.output}`} />
        <MetricCard label={t('ai.action_history')} value={actionLogs.length} hint={t('ai.undo')} />
        <MetricCard label={t('ai.context_title')} value={contextData ? t('analytics.status_good') : '-'} hint={t('ai.show_context')} />
      </div>

      {/* AI Status Banner */}
      {aiStatus === 'no_key' && (
        <div className="card" style={{
          padding: '12px 16px',
          marginBottom: 12,
          background: '#fff8e1',
          border: '1px solid #ffe082',
          fontSize: 13,
        }}>
          <CircleAlert size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
          {t('ai.no_key_banner_prefix')}
          <span style={{cursor:'pointer', textDecoration:'underline', fontWeight:'bold'}} onClick={() => window.location.hash = '#settings-ai'}>{t('settings.title')}</span>
          {t('ai.no_key_banner_suffix')}
        </div>
      )}
      {aiStatus === 'offline' && (
        <div className="card" style={{
          padding: '12px 16px',
          marginBottom: 12,
          background: '#ffebee',
          border: '1px solid #ef9a9a',
          fontSize: 13,
        }}>
          <WifiOff size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />
          {t('ai.offline_banner')}
        </div>
      )}

      {/* Stream Error Banner */}
      {streamError && (
        <div className="card" style={{
          padding: '8px 12px',
          marginBottom: 12,
          background: '#fff3e0',
          border: '1px solid #ffcc80',
          fontSize: 13,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}>
          <span><CircleAlert size={16} style={{ verticalAlign: '-3px', marginRight: 6 }} />{streamError}</span>
          <button
            className="btn btn-secondary"
            style={{ fontSize: 11, padding: '2px 8px' }}
            onClick={() => setStreamError(null)}
          >
            {t('common.close')}
          </button>
        </div>
      )}

      {/* Context Panel */}
      {showContext && contextData && (
        <Panel title={t('ai.context_title')} icon={<Database size={17} />}>
          <pre style={{ margin: 0, whiteSpace: 'pre-wrap', fontFamily: 'monospace', fontSize: 11 }}>
            {JSON.stringify(contextData, null, 2)}
          </pre>
        </Panel>
      )}

      {/* Action Logs Panel */}
      {showLogs && (
        <Panel title={t('ai.action_history')} icon={<TerminalSquare size={17} />}>
          {actionLogs.length === 0 && <EmptyPanel>{t('ai.no_action_logs')}</EmptyPanel>}
          {actionLogs.map((log) => (
            <div
              key={log.id}
              className="tool-log-row"
            >
              <span className="field-help">
                {log.created_at?.slice(11, 19)}
              </span>
              <span>
                <strong>{log.capability}</strong>
                <span className="field-help" style={{ marginLeft: 8 }}>{log.actor}/{log.origin}</span>
              </span>
              <button
                className="btn btn-secondary"
                onClick={async () => {
                  const r = await callCapability('undo.revert_action', {
                    action_log_id: log.id,
                  }) as { success: boolean };
                  if (r.success) {
                    loadActionLogs();
                    setMessages((prev) => [
                      ...prev,
                      {
                        id: `sys_${Date.now()}`,
                        role: 'system',
                        content: t('ai.undo_success', { capability: log.capability }),
                        timestamp: Date.now(),
                      },
                    ]);
                  }
                }}
              >
                {t('ai.undo')}
              </button>
            </div>
          ))}
        </Panel>
      )}

      {/* Dream Status */}
      {dreamStatus && (
        <Panel title={t('ai.dream_label')} icon={<Brain size={17} />} meta={`${t('dream.session')}: ${dreamStatus.sessionCount}`}>
          <div className="field-help">
            {dreamStatus.lastDreamTime
              ? t('ai.dream_last_run', { time: new Date(dreamStatus.lastDreamTime).toLocaleString(locale) })
              : t('ai.dream_never_run')}
          </div>
        </Panel>
      )}

      {/* Quick Actions */}
      <div className="assistant-actions">
        {([
          'plan_today',
          'whats_today',
          'analyze',
          'create_high_priority',
          'explain_schedule',
        ] as const).map((actionKey) => {
          const label = t(`ai.quick_actions.${actionKey}`);
          return (
            <button
              key={actionKey}
              className="mini-action"
              onClick={() => handleQuickAction(label)}
            >
              <Wand2 size={14} />
              {label}
            </button>
          );
        })}
      </div>

      {/* Chat Messages */}
      <div
        role="log"
        aria-live="polite"
        aria-label={t('ai.aria_chat_log')}
        className="ai-message-list"
      >
        {messages.map((msg) => (
          <div key={msg.id} style={{ marginBottom: 16 }}>
            {/* Message Bubble */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
              }}
            >
              <div
                role="article"
                aria-label={`${msg.role === 'user' ? t('ai.role_user') : msg.role === 'system' ? t('ai.role_system') : t('ai.role_assistant')}${t('ai.aria_message_suffix')}${msg.isStreaming ? t('ai.aria_streaming_suffix') : ''}`}
                className={`message-card ${msg.role}`}
              >
                {/* Thinking block (collapsible) */}
                {msg.thinking && (
                  <details style={{ marginBottom: 8 }}>
                    <summary style={{
                      cursor: 'pointer',
                      color: '#888',
                      fontSize: 11,
                      fontStyle: 'italic',
                    }}>
                      &#x1F4AD; {t('ai.thinking')}
                    </summary>
                    <div style={{
                      marginTop: 4,
                      padding: 8,
                      background: '#f9f9f9',
                      borderRadius: 4,
                      fontSize: 11,
                      color: '#666',
                      whiteSpace: 'pre-wrap',
                    }}>
                      {msg.thinking}
                    </div>
                  </details>
                )}

                {/* Message content with markdown rendering */}
                {msg.role === 'assistant' ? (
                  <div style={{ whiteSpace: 'normal' }}>
                    {renderMessageContent(msg.content)}
                  </div>
                ) : (
                  <div style={{ whiteSpace: 'pre-wrap' }}>
                    {msg.content}
                  </div>
                )}

                {/* Streaming cursor */}
                {msg.isStreaming && (
                  <span className="streaming-cursor" style={{
                    display: 'inline-block',
                    width: 2,
                    height: 14,
                    background: '#4a6fa5',
                    marginLeft: 2,
                    animation: 'blink 1s infinite',
                  }} />
                )}

                {/* Tool calls */}
                {msg.toolCalls && msg.toolCalls.length > 0 && (
                  <div style={{ marginTop: 8, borderTop: '1px solid #eee', paddingTop: 8 }}>
                    {msg.toolCalls.map((tc) => (
                      <details key={tc.toolUseId} style={{ marginBottom: 4 }}>
                        <summary style={{
                          cursor: 'pointer',
                          fontSize: 11,
                          color: tc.status === 'error' ? '#f44336' : '#4a6fa5',
                          fontWeight: 500,
                        }}>
                          {tc.status === 'running' ? '\u{1F504}' : tc.status === 'done' ? '✅' : '❌'}
                          {' '}{formatToolName(tc.toolName)}
                          {tc.status === 'running' && ` ${t('ai.status_label.running')}`}
                        </summary>
                        <div style={{
                          fontSize: 10,
                          color: '#666',
                          padding: '4px 8px',
                          background: '#f9f9f9',
                          borderRadius: 4,
                          marginTop: 2,
                        }}>
                          {tc.toolInput && (
                            <div>{t('ai.tool_input_label')}{JSON.stringify(tc.toolInput, null, 1)}</div>
                          )}
                          {tc.toolResult !== null && tc.toolResult !== undefined && (
                            <div>{t('ai.tool_result_label')}{String(JSON.stringify(tc.toolResult, null, 1))}</div>
                          )}
                          {tc.error && (
                            <div style={{ color: '#f44336' }}>{t('ai.tool_error_label')}{tc.error}</div>
                          )}
                        </div>
                      </details>
                    ))}
                  </div>
                )}
              </div>

              {/* Timestamp */}
              <span className={`message-meta ${msg.role === 'user' ? 'user' : ''}`}>
                {msg.role === 'user' ? t('ai.user_label') : t('ai.ai_label')} {' '}{formatTimestamp(msg.timestamp)}
              </span>
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input Area */}
      <div className="ai-input-bar">
        <input
          ref={inputRef}
          type="text"
          placeholder={
            aiStatus === 'no_key'
              ? t('ai.input_no_key')
              : isStreaming
                ? t('ai.input_streaming')
                : t('ai.input_placeholder')
          }
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          disabled={aiStatus === 'no_key'}
        />
        {isStreaming ? (
          <button
            className="btn btn-secondary"
            onClick={handleStopGeneration}
            style={{ background: 'var(--danger)', color: '#fff' }}
          >
            <Square size={15} />
            {t('ai.stop')}
          </button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={handleSend}
            disabled={aiStatus === 'no_key' || !input.trim()}
          >
            <Send size={15} />
            {t('ai.send')}
          </button>
        )}
      </div>

      {/* CSS for streaming cursor animation */}
      <style>{`
        @keyframes blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
      `}</style>
    </PageShell>
  );
}

// Type used by context loading
interface ConversationContext {
  currentDate: string;
  todayTasks: Array<unknown>;
  todayEvents: Array<unknown>;
  todayBlocks: Array<unknown>;
  overdueTasks: Array<unknown>;
  workHours: { start: string; end: string };
  scheduleStyle: string;
  preferences: Record<string, string>;
  dreamInsights: string[];
  pendingReminders: number;
  completedToday: number;
  totalPending: number;
}
