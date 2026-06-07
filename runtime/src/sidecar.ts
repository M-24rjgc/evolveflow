import * as readline from 'readline';

// ── Sentry (optional error tracking) ──────────────────────────
// Only activated when EVOLVEFLOW_SENTRY_DSN is configured.
// Falls back to no-ops when @sentry/node is not installed.
let _sentryCaptureException: (err: unknown, opts?: Record<string, unknown>) => void = () => {};
const SENTRY_DSN = process.env.EVOLVEFLOW_SENTRY_DSN || '';
if (SENTRY_DSN) {
  import('@sentry/node')
    .then((Sentry) => {
      Sentry.init({
        dsn: SENTRY_DSN,
        tracesSampleRate: 0.1,
        environment: process.env.NODE_ENV || 'production',
      });
      _sentryCaptureException = (err, opts) =>
        Sentry.captureException(err, opts as Parameters<typeof Sentry.captureException>[1]);
    })
    .catch(() => {});
}
function captureException(err: unknown, opts?: Record<string, unknown>) {
  _sentryCaptureException(err, opts);
}
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { EvolveFlowDatabase, ensureDataDirs } from '@evolveflow/storage';
import { createRegistry } from '@evolveflow/capabilities';

// ── AI Engine ────────────────────────────────────────────────
import { ApiClient, ApiError } from './ai/client.js';
import {
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_MODEL,
  DEEPSEEK_MODEL_DISPLAY,
  DEEPSEEK_PROVIDER,
  getThinkingForMode,
  getEnvDeepSeekApiKey,
  type AgentMode,
} from './ai/deepseek.js';
import { capabilitiesToTools, getToolListingPrompt } from './ai/tools.js';
import {
  runConversation,
  createSession,
  getSession,
  deleteSession,
  getAllSessions,
} from './ai/loop.js';
import { buildConversationContext } from './ai/context.js';
import type { SystemMessageParam, AiStreamChunk, ConversationContext } from './ai/types.js';
import type { AnthropicTool } from './ai/types.js';

// ── Dream Orchestrator ─────────────────────────────────────────
import { DreamOrchestrator } from './dream.js';
import { MemoryProjectionService, PreferenceService } from '@evolveflow/domain';

// ── Buddy System ────────────────────────────────────────────────
import { BuddyCore } from './buddy.js';

// ── JSON-RPC Message Types ───────────────────────────────────

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
  request_id?: string;
  command?: string;
  payload?: Record<string, unknown>;
  idempotency_key?: string;
  session_id?: string;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id?: string | number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  request_id?: string;
  trace_id?: string;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: Record<string, unknown>;
  request_id?: string;
}

type Message = JsonRpcRequest | JsonRpcNotification;

// ── Allowed Capabilities ─────────────────────────────────────

const ALLOWED_CAPABILITIES = new Set([
  'task.create',
  'task.update',
  'task.complete',
  'task.defer',
  'task.lock',
  'task.delete',
  'task.cancel',
  'event.create',
  'event.update',
  'event.lock',
  'event.delete',
  'event.find_conflicts',
  'schedule.plan_day',
  'schedule.plan_range',
  'schedule.rebalance',
  'schedule.clear_day',
  'schedule.get_blocks',
  'schedule.explain',
  'schedule.analyze_quality',
  'reminder.snooze',
  'summary.generate_daily',
  'history.list_actions',
  'undo.revert_action',
  'memory.clear_ai_history',
  'memory.clear_learned_state',
  'heartbeat',
  'shutdown',
  'rebuild_state',
  'task.list',
  'event.list',
  'preference.set',
  'preference.get',
  'api_key.status',
  'file.list',
  'file.read',
  'file.search',
  'file.write',
  'terminal.run',
  // AI methods
  'ai.chat',
  'ai.stream',
  'ai.get_sessions',
  'ai.delete_session',
  'ai.get_context',
  'ai.check_connectivity',
  'ai.cancel_stream',
  'ai.approve_tool',
  'ai.suggest_today',
  // Dream methods
  'dream.run',
  'dream.status',
  'dream.get_insights',
  // Reminder methods
  'reminder.list',
  // Backup methods
  'backup.list',
  'backup.create',
  'backup.verify',
  'backup.restore',
  'backup.delete',
  // Buddy methods
  'buddy.greet',
  'buddy.comment',
]);

// ── Global State ─────────────────────────────────────────────

let _registry: ReturnType<typeof createRegistry> | null = null;
let _db: EvolveFlowDatabase | null = null;
let _aiClient: ApiClient | null = null;
let _aiTools: AnthropicTool[] = [];
let _aiSystemPrompt: SystemMessageParam[] = [];
let _lastConnectivityCheckAt = 0;
let _lastConnectivityResult: { connected: boolean; reason?: string } = {
  connected: false,
  reason: 'not checked',
};

let reminderQueue: Array<{
  id: string;
  triggerAt: string;
  message: string | null;
  taskId: string | null;
}> = [];
let pendingTaskIds: string[] = [];

const AGENT_MODES = new Set<AgentMode>(['chat', 'plan', 'auto', 'yolo']);

// ── Stream Lifecycle Management ───────────────────────────────
const streamControllers = new Map<string, AbortController>();
const pendingToolApprovals = new Map<
  string,
  {
    resolve: (allow: boolean) => void;
    timeout: ReturnType<typeof setTimeout>;
  }
>();

// ── Dream Orchestrator ────────────────────────────────────────
let _dreamOrchestrator: DreamOrchestrator | null = null;
let _memoryProjectionService: MemoryProjectionService | null = null;
let _lastUserActivityTime: number = Date.now();
let _lastRunActionLogCount: number = 0;

// ── Buddy System ───────────────────────────────────────────────
let _buddyCore: BuddyCore | null = null;

// ── Message Router ───────────────────────────────────────────

async function handleMessage(msg: Message): Promise<JsonRpcResponse | null> {
  const requestId = (msg as JsonRpcRequest).request_id;
  const traceId = crypto.randomUUID();

  if (!('id' in msg)) {
    handleNotification(msg as JsonRpcNotification);
    return null;
  }

  const request = msg as JsonRpcRequest;
  const { method, params } = request;

  // Record user activity for dream idle tracking
  _lastUserActivityTime = Date.now();
  _dreamOrchestrator?.recordSession();

  // ── System methods ──────────────────────────────
  if (method === 'heartbeat') {
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: {
        status: 'alive',
        timestamp: Date.now(),
        reminderQueueLength: reminderQueue.length,
        aiReady: _aiClient !== null,
        sessions: getAllSessions().length,
      },
    };
  }

  if (method === 'shutdown') {
    sendNotification('system.shutting_down', { timestamp: Date.now() });
    setTimeout(() => process.exit(0), 100);
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: { status: 'shutting_down' },
    };
  }

  if (method === 'rebuild_state') {
    const data = params as
      | {
          reminders?: Array<{
            id: string;
            triggerAt: string;
            message: string | null;
            taskId: string | null;
          }>;
          pendingTaskIds?: string[];
        }
      | undefined;
    if (data?.reminders) {
      reminderQueue = data.reminders;
    }
    if (data?.pendingTaskIds) {
      pendingTaskIds = data.pendingTaskIds;
    }
    sendNotification(
      'state.rebuilt',
      {
        reminderCount: reminderQueue.length,
        pendingTaskCount: pendingTaskIds.length,
      },
      requestId
    );
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: {
        status: 'state_rebuilt',
        reminderCount: reminderQueue.length,
        pendingTaskCount: pendingTaskIds.length,
      },
    };
  }

  // ── AI methods ──────────────────────────────────
  if (method === 'ai.chat') {
    return handleAiChat(request, params || {}, traceId);
  }

  if (method === 'ai.stream') {
    return handleAiStream(request, params || {}, traceId);
  }

  if (method === 'ai.get_sessions') {
    const sessions = getAllSessions().map((s) => ({
      sessionId: s.sessionId,
      messageCount: s.messages.length,
      createdAt: s.createdAt,
      lastActivityAt: s.lastActivityAt,
      totalInputTokens: s.totalTokens.input_tokens,
      totalOutputTokens: s.totalTokens.output_tokens,
    }));
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: { sessions },
    };
  }

  if (method === 'ai.delete_session') {
    const sessionId = (params as { session_id?: string })?.session_id;
    if (sessionId) {
      deleteSession(sessionId);
    }
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: { deleted: !!sessionId },
    };
  }

  if (method === 'ai.get_context') {
    if (!_db || !_registry) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        trace_id: traceId,
        error: { code: -32000, message: 'Database not initialized' },
      };
    }
    try {
      const ctx = await buildConversationContext(_db, _registry);
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        result: ctx,
      };
    } catch (err) {
      console.error(`[sidecar] ai.get_context error [trace_id=${traceId}]:`, err);
      captureException(err, {
        tags: { trace_id: traceId, method: 'ai.get_context', source: 'handleMessage' },
      });
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        trace_id: traceId,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (method === 'ai.check_connectivity') {
    if (!_aiClient) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        result: { connected: false, reason: 'AI client not initialized' },
      };
    }
    const force = !!(params as { force?: boolean } | undefined)?.force;
    const now = Date.now();
    if (force || now - _lastConnectivityCheckAt > 300_000) {
      const connected = await _aiClient.checkConnectivity();
      _lastConnectivityResult = connected
        ? { connected: true }
        : {
            connected: false,
            reason: 'DeepSeek request failed. Check API key, quota, and network.',
          };
      _lastConnectivityCheckAt = now;
    }
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: _lastConnectivityResult,
    };
  }

  if (method === 'ai.cancel_stream') {
    const sessionId = (params as { session_id?: string })?.session_id;
    const hadSession = sessionId && streamControllers.has(sessionId);
    if (hadSession) {
      streamControllers.get(sessionId)!.abort();
      streamControllers.delete(sessionId);
      console.error(
        `[sidecar] Stream cancelled by client [session_id=${sessionId}, trace_id=${traceId}]`
      );
    }
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: { cancelled: !!hadSession, session_id: sessionId },
    };
  }

  if (method === 'ai.approve_tool') {
    const approvalId = (params as { approval_id?: string })?.approval_id;
    const allow = !!(params as { allow?: boolean })?.allow;
    if (!approvalId || !pendingToolApprovals.has(approvalId)) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        result: { success: false, error: 'Approval request not found' },
      };
    }
    const pending = pendingToolApprovals.get(approvalId)!;
    clearTimeout(pending.timeout);
    pendingToolApprovals.delete(approvalId);
    pending.resolve(allow);
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: { success: true, approval_id: approvalId, allow },
    };
  }

  if (method === 'ai.suggest_today') {
    return handleAiSuggestToday(request, params || {}, traceId);
  }

  // ── Dream methods ─────────────────────────────────
  if (method === 'dream.run') {
    if (!_dreamOrchestrator) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        trace_id: traceId,
        error: { code: -32000, message: 'Dream orchestrator not initialized' },
      };
    }
    try {
      const result = await _dreamOrchestrator.run();
      if (
        result.status === 'completed' &&
        result.insights &&
        result.insights.length > 0 &&
        _memoryProjectionService
      ) {
        // Project all learned preferences from the dream analysis
        const prefs = result.preferences || {};
        _memoryProjectionService.projectFromDream({
          confidence:
            result.insights.reduce((sum, i) => sum + i.confidence, 0) / result.insights.length,
          insights: result.insights.map((i) => ({
            id: i.id,
            category: i.category,
            description: i.description,
            confidence: i.confidence,
            suggestion: i.suggestion,
          })),
          preferredWorkHours: prefs.preferredWorkHours,
          energyPatterns: prefs.energyPatterns,
          scheduleAdherence: prefs.scheduleAdherence,
          productivityTrend: prefs.productivityTrend,
          taskPreferences: prefs.taskPreferences,
        });
        sendNotification(
          'dream.completed',
          {
            insights: result.insights,
            summary: result.summary,
          },
          requestId
        );

        // Forward buddy adjustments if present
        if (result.buddyAdjustments) {
          if (_buddyCore) {
            _buddyCore.applyDreamInsights(result.buddyAdjustments);
          }
          sendNotification(
            'dream.buddy_adjustments',
            {
              adjustments: result.buddyAdjustments,
            },
            requestId
          );
        }
      }
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        result,
      };
    } catch (err) {
      console.error(`[sidecar] dream.run error [trace_id=${traceId}]:`, err);
      captureException(err, {
        tags: { trace_id: traceId, method: 'dream.run', source: 'handleMessage' },
      });
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        trace_id: traceId,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  if (method === 'dream.status') {
    if (!_dreamOrchestrator) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        trace_id: traceId,
        error: { code: -32000, message: 'Dream orchestrator not initialized' },
      };
    }
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: _dreamOrchestrator.getStatus(),
    };
  }

  // ── Buddy methods ──────────────────────────────────
  if (method === 'buddy.greet') {
    if (!_buddyCore) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        trace_id: traceId,
        error: { code: -32000, message: 'Buddy not initialized' },
      };
    }
    const greeting = _buddyCore.generateGreeting();
    const state = _buddyCore.getState();
    _buddyCore.recordInteraction();
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: {
        greeting,
        mood: state.mood,
        level: _buddyCore.getLevel(),
        personality: _buddyCore.getPersonality(),
      },
    };
  }

  if (method === 'buddy.comment') {
    if (!_buddyCore) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        trace_id: traceId,
        error: { code: -32000, message: 'Buddy not initialized' },
      };
    }
    const taskCount = (params?.taskCount as number) || 0;
    const comment = _buddyCore.generateScheduleComment(taskCount);
    const state = _buddyCore.getState();
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: { comment, mood: state.mood },
    };
  }

  if (method === 'buddy.celebrate') {
    if (!_buddyCore) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        trace_id: traceId,
        error: { code: -32000, message: 'Buddy not initialized' },
      };
    }
    const celebration = _buddyCore.generateCompletionCelebration();
    const state = _buddyCore.getState();
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: { celebration, mood: state.mood },
    };
  }

  if (method === 'buddy.infer_mood') {
    if (!_buddyCore) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        trace_id: traceId,
        error: { code: -32000, message: 'Buddy not initialized' },
      };
    }
    const completedRatio = (params?.completedRatio as number) || 0;
    const pendingCount = (params?.pendingCount as number) || 0;
    const isLate = (params?.isLate as boolean) || false;
    const mood = _buddyCore.inferMood(completedRatio, pendingCount, isLate);
    _buddyCore.setMood(mood);
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: { mood },
    };
  }

  if (method === 'buddy.set_level') {
    if (!_buddyCore) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        trace_id: traceId,
        error: { code: -32000, message: 'Buddy not initialized' },
      };
    }
    const level = params?.level as 'full' | 'minimal' | 'off';
    if (level && ['full', 'minimal', 'off'].includes(level)) {
      _buddyCore.setLevel(level);
    }
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: { level: _buddyCore.getLevel() },
    };
  }

  // ── Summary methods ──────────────────────────────
  if (method === 'summary.generate_daily') {
    return handleSummaryGenerateDaily(request, params || {}, traceId);
  }

  if (method === 'api_key.status') {
    try {
      const storedValue = getStoredApiKey();
      const envValue = getEnvApiKey();
      const activeValue = storedValue || envValue;
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        result: {
          success: true,
          data: {
            configured: !!activeValue,
            prefix: activeValue ? activeValue.slice(-4) : '',
            source: storedValue ? 'stored' : envValue ? 'environment' : 'none',
            provider: resolveAiProvider(),
            model: resolveAiModel(),
            modelDisplay: DEEPSEEK_MODEL_DISPLAY,
            baseUrl: resolveAiBaseUrl(),
          },
        },
      };
    } catch (err) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        trace_id: traceId,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      };
    }
  }

  // ── Standard capability invocation ──────────────
  if (!ALLOWED_CAPABILITIES.has(method)) {
    console.error(`[sidecar] Method not found [trace_id=${traceId}]: ${method}`);
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      trace_id: traceId,
      error: {
        code: -32601,
        message: `Method not found or not allowed: ${method}`,
      },
    };
  }

  const command = request.command || method;
  const payload = request.payload || params || {};

  try {
    const result = await _registry!.invoke(method, payload, {
      actor: 'user',
      origin: 'gui',
      idempotency_key: request.idempotency_key,
      session_id: request.session_id,
    });
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: result,
    };
  } catch (err) {
    console.error(
      `[sidecar] Capability invocation error [trace_id=${traceId}, method=${method}]:`,
      err
    );
    captureException(err, {
      tags: { trace_id: traceId, method, source: 'capability_invocation' },
      extra: { payload },
    });
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      trace_id: traceId,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ── AI Handlers ───────────────────────────────────────────────

async function handleAiChat(
  request: JsonRpcRequest,
  params: Record<string, unknown>,
  traceId: string
): Promise<JsonRpcResponse> {
  if (!_aiClient || !_registry || !_db) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: request.request_id,
      trace_id: traceId,
      error: { code: -32000, message: 'AI engine not initialized. Set API key in Settings.' },
    };
  }

  const message = params.message as string;
  const sessionId = (params.session_id as string) || crypto.randomUUID();
  const fastMode = params.fast !== false;
  const mode = resolveAgentMode(params.mode, fastMode ? 'chat' : 'auto');

  if (!message || !message.trim()) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: request.request_id,
      trace_id: traceId,
      error: { code: -32602, message: 'message is required' },
    };
  }

  try {
    // Build fresh context
    const context = await buildConversationContext(_db, _registry);

    const collectedChunks: AiStreamChunk[] = [];
    let finalText = '';
    let errorMsg = '';

    const gen = runConversation(message, {
      client: _aiClient,
      registry: _registry,
      tools: getToolsForMode(mode, fastMode),
      systemPrompt: _aiSystemPrompt,
      context,
      sessionId,
      maxTurns: fastMode ? 1 : undefined,
      maxTokens: fastMode ? 1200 : undefined,
      temperature: fastMode ? 0.4 : undefined,
      thinking: getThinkingForMode(mode, fastMode),
      onChunk: (chunk) => {
        collectedChunks.push(chunk);
        if (chunk.type === 'text_delta') {
          finalText += chunk.content || '';
        }
        if (chunk.type === 'error') {
          errorMsg = chunk.error || errorMsg;
        }
      },
    });

    for await (const _chunk of gen) {
      // Accumulated via onChunk callback
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: request.request_id,
      result: {
        session_id: sessionId,
        text: finalText,
        error: errorMsg || undefined,
        chunks: collectedChunks.map((c) => ({
          type: c.type,
          content: c.content,
          tool_name: c.tool_name,
          tool_result: c.tool_result,
        })),
      },
    };
  } catch (err) {
    console.error(`[sidecar] ai.chat error [trace_id=${traceId}, session_id=${sessionId}]:`, err);
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: request.request_id,
      trace_id: traceId,
      error: {
        code: -32000,
        message:
          err instanceof ApiError
            ? `AI API错误 [${err.status}]: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err),
      },
    };
  }
}

async function handleAiStream(
  request: JsonRpcRequest,
  params: Record<string, unknown>,
  traceId: string
): Promise<JsonRpcResponse> {
  if (!_aiClient || !_registry || !_db) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: request.request_id,
      trace_id: traceId,
      error: { code: -32000, message: 'AI engine not initialized. Set API key in Settings.' },
    };
  }

  const message = params.message as string;
  const sessionId = (params.session_id as string) || crypto.randomUUID();
  const mode = resolveAgentMode(params.mode, 'auto');

  if (!message || !message.trim()) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: request.request_id,
      trace_id: traceId,
      error: { code: -32602, message: 'message is required' },
    };
  }

  // Set up cancellable streaming
  const controller = new AbortController();
  streamControllers.set(sessionId, controller);

  // Auto-GC orphaned streams after 5 minutes
  const gcTimer = setTimeout(() => {
    if (streamControllers.has(sessionId)) {
      controller.abort();
      streamControllers.delete(sessionId);
      console.error(`[sidecar] Stream auto-aborted after GC timeout [session_id=${sessionId}]`);
    }
  }, 300_000);

  // Respond immediately with session info, then stream asynchronously
  const response: JsonRpcResponse = {
    jsonrpc: '2.0',
    id: request.id,
    request_id: request.request_id,
    result: {
      session_id: sessionId,
      streaming: true,
    },
  };

  // Start streaming in background
  setImmediate(async () => {
    try {
      const context = await buildConversationContext(_db!, _registry!);

      const gen = runConversation(message, {
        client: _aiClient!,
        registry: _registry!,
        tools: getToolsForMode(mode),
        systemPrompt: _aiSystemPrompt,
        context,
        sessionId,
        abortSignal: controller.signal,
        thinking: getThinkingForMode(mode),
        confirmToolUse: async (permission) => {
          if (!permission.mutating || mode === 'yolo') {
            return true;
          }
          const allow = await waitForToolApproval(permission.approvalId);
          return {
            allow,
            reason: allow ? undefined : `用户拒绝执行工具: ${permission.capabilityName}`,
            requiresApproval: true,
          };
        },
        onChunk: (chunk) => {
          // Emit each chunk as a streaming event
          sendNotification(
            'ai.stream_chunk',
            {
              ...chunk,
            },
            request.request_id
          );
        },
      });

      for await (const _chunk of gen) {
        // Streamed via onChunk callback
      }
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') {
        sendNotification(
          'ai.stream_chunk',
          {
            type: 'done',
            session_id: sessionId,
            done: true,
            content: 'Stream cancelled by user',
          },
          request.request_id
        );
        return;
      }
      console.error(
        `[sidecar] ai.stream error [trace_id=${traceId}, session_id=${sessionId}]:`,
        err
      );
      sendNotification(
        'ai.stream_chunk',
        {
          type: 'error',
          session_id: sessionId,
          error: err instanceof Error ? err.message : String(err),
          done: true,
        },
        request.request_id
      );
    } finally {
      clearTimeout(gcTimer);
      streamControllers.delete(sessionId);
    }
  });

  return response;
}

async function handleAiSuggestToday(
  request: JsonRpcRequest,
  _params: Record<string, unknown>,
  traceId: string
): Promise<JsonRpcResponse> {
  if (!_aiClient || !_registry || !_db) {
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: request.request_id,
      trace_id: traceId,
      error: { code: -32000, message: 'AI engine not initialized. Set API key in Settings.' },
    };
  }

  try {
    const context = await buildConversationContext(_db, _registry);
    const compactContext = {
      currentDate: context.currentDate,
      workHours: context.workHours,
      scheduleStyle: context.scheduleStyle,
      totalPending: context.totalPending,
      completedToday: context.completedToday,
      overdueTasks: context.overdueTasks.slice(0, 8),
      todayTasks: context.todayTasks.slice(0, 12),
      todayEvents: context.todayEvents.slice(0, 8),
      todayBlocks: context.todayBlocks.slice(0, 16),
      dreamInsights: context.dreamInsights.slice(0, 5),
      pendingReminders: context.pendingReminders,
    };

    const result = await _aiClient.createMessage(
      [
        {
          role: 'user',
          content: `请基于以下 EvolveFlow 今日上下文，生成一条真正有帮助的中文日程建议。不要创建、修改或删除任何数据；不要输出 JSON；不要使用 Markdown；控制在 80 个汉字以内。\n\n${JSON.stringify(compactContext, null, 2)}`,
        },
      ],
      undefined,
      [
        {
          type: 'text',
          text: '你是 EvolveFlow 的日程建议引擎。你只输出一条针对当前用户数据的可执行建议，不编造不存在的任务或事件。',
        },
      ],
      { maxTokens: 512, temperature: 0.4 }
    );

    const suggestion = result.response.content
      .filter((block) => block.type === 'text')
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('')
      .trim();

    if (!suggestion) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: request.request_id,
        trace_id: traceId,
        error: { code: -32000, message: 'AI returned no text suggestion' },
      };
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: request.request_id,
      result: {
        success: true,
        data: {
          suggestion,
          usage: result.usage,
        },
      },
    };
  } catch (err) {
    console.error(`[sidecar] ai.suggest_today error [trace_id=${traceId}]:`, err);
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: request.request_id,
      trace_id: traceId,
      error: {
        code: -32000,
        message:
          err instanceof ApiError
            ? `AI API错误 [${err.status}]: ${err.message}`
            : err instanceof Error
              ? err.message
              : String(err),
      },
    };
  }
}

// ── Summary Generate Daily ───────────────────────────────────────

async function handleSummaryGenerateDaily(
  request: JsonRpcRequest,
  params: Record<string, unknown>,
  traceId: string
): Promise<JsonRpcResponse> {
  const requestId = request.request_id;

  try {
    // 1. Get raw stats from the existing capability
    const result = await _registry!.invoke('summary.generate_daily', params, {
      actor: 'user',
      origin: 'gui',
      idempotency_key: request.idempotency_key,
      session_id: request.session_id,
    });

    const resultData = result as { success: boolean; data?: Record<string, unknown> } | undefined;
    const data = resultData?.data;

    // 2. Generate AI insights if AI client is available
    let insights: string[] | undefined;
    let summaryText: string | undefined;

    if (_aiClient && data) {
      try {
        const date = (params.date as string) || new Date().toISOString().split('T')[0];
        const completedItems = Array.isArray(data.completed_items)
          ? (data.completed_items as string[])
          : [];
        const incompleteItems = Array.isArray(data.incomplete_items)
          ? (data.incomplete_items as string[])
          : [];
        const deferredItems = Array.isArray(data.deferred_items)
          ? (data.deferred_items as string[])
          : [];

        // Query previous summaries for comparison context
        let previousContext = '';
        try {
          const prevRows = _db!
            .getDb()
            .prepare(
              'SELECT date, completed_items, incomplete_items FROM daily_summaries WHERE date < ? ORDER BY date DESC LIMIT 3'
            )
            .all(date) as Array<{
            date: string;
            completed_items: string;
            incomplete_items: string;
          }>;
          if (prevRows.length > 0) {
            previousContext =
              '\nRecent days:\n' +
              prevRows
                .map(
                  (r) =>
                    `- ${r.date}: completed ${JSON.parse(r.completed_items).length}, incomplete ${JSON.parse(r.incomplete_items).length}`
                )
                .join('\n');
          }
        } catch {
          /* no previous data */
        }

        const prompt = `You are EvolveFlow, a personal productivity assistant. Analyze the user's daily task data and provide concise, actionable insights in Chinese.

Today's data:
- Completed (${completedItems.length}): ${completedItems.join(', ') || 'none'}
- Incomplete (${incompleteItems.length}): ${incompleteItems.join(', ') || 'none'}
- Deferred (${deferredItems.length}): ${deferredItems.join(', ') || 'none'}${previousContext}

Return ONLY valid JSON. No markdown, no code fences, no explanation:
{
  "summary": "2-3 sentence Chinese overview of today's productivity",
  "comparison": "Chinese comparison to recent days or patterns noticed",
  "suggestion": "One concrete Chinese suggestion for tomorrow",
  "mood": "productive|moderate|needs_improvement"
}`;

        const aiResult = await _aiClient.createMessage(
          [{ role: 'user', content: prompt }],
          undefined,
          undefined,
          { maxTokens: 500, temperature: 0.7 }
        );

        const text = aiResult.response.content
          .filter((c) => c.type === 'text')
          .map((c) => (c as { text: string }).text)
          .join(' ');

        const jsonMatch = text.match(/\{[\sS]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          insights = [
            parsed.summary || '',
            `📈 ${parsed.comparison || ''}`,
            `💡 ${parsed.suggestion || ''}`,
            `🎯 ${parsed.mood || ''}`,
          ].filter(Boolean);
          summaryText = parsed.summary || '';
        }
      } catch (aiErr) {
        console.error(`[sidecar] AI insight generation error [trace_id=${traceId}]:`, aiErr);
        // Non-fatal: return summary without AI insights
      }
    }

    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: {
        success: true,
        data: {
          ...(data || {}),
          insights,
          summary_text: summaryText,
        },
      },
    };
  } catch (err) {
    console.error(`[sidecar] summary.generate_daily error [trace_id=${traceId}]:`, err);
    captureException(err, {
      tags: { trace_id: traceId, method: 'summary.generate_daily', source: 'handleMessage' },
    });
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      trace_id: traceId,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
    };
  }
}

// ── Notification Handling ─────────────────────────────────────

function handleNotification(msg: JsonRpcNotification): void {
  console.error(
    `[sidecar] Notification received: method=${msg.method}`,
    msg.params ? JSON.stringify(msg.params).slice(0, 200) : '(no params)'
  );
}

function sendNotification(
  method: string,
  params: Record<string, unknown>,
  requestId?: string
): void {
  const notification: JsonRpcNotification = {
    jsonrpc: '2.0',
    method,
    params,
  };
  if (requestId) {
    notification.request_id = requestId;
  }
  process.stdout.write(JSON.stringify(notification) + '\n');
}

function waitForToolApproval(approvalId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingToolApprovals.delete(approvalId);
      resolve(false);
    }, 120_000);
    pendingToolApprovals.set(approvalId, { resolve, timeout });
  });
}

// ── Reminder Poller ───────────────────────────────────────────

function startReminderPoller(): void {
  setInterval(() => {
    const now = Date.now();
    const dueReminders = reminderQueue.filter((reminder) => {
      const triggerTime = new Date(reminder.triggerAt).getTime();
      return Number.isFinite(triggerTime) && triggerTime <= now;
    });

    for (const reminder of dueReminders) {
      sendNotification('reminder.due', {
        reminder_id: reminder.id,
        message: reminder.message || '提醒时间到了',
        task_id: reminder.taskId,
      });
    }

    if (dueReminders.length > 0) {
      const dueIds = new Set(dueReminders.map((r) => r.id));
      reminderQueue = reminderQueue.filter((r) => !dueIds.has(r.id));

      if (_db) {
        const placeholders = dueReminders.map(() => '?').join(',');
        _db
          .getDb()
          .prepare(`UPDATE reminders SET status = 'triggered' WHERE id IN (${placeholders})`)
          .run(...dueReminders.map((r) => r.id));
      }
    }
  }, 10000);
}

// ── Daily Summary Scheduler ───────────────────────────────────

function startDailySummaryScheduler(): void {
  setInterval(async () => {
    const now = new Date();
    if (now.getHours() === 23 && now.getMinutes() === 0) {
      const date = now.toISOString().split('T')[0];
      try {
        // Actually generate and persist the summary via the capability
        if (_registry) {
          await _registry.invoke(
            'summary.generate_daily',
            { date },
            {
              actor: 'system',
              origin: 'reminder_system',
            }
          );
        }
      } catch (err) {
        console.error('[sidecar] Daily summary generation failed:', err);
      }
      // Notify frontend so it can refresh if open
      sendNotification('summary.auto_generate', { date });
    }
  }, 60000);
}

// ── Dream Scheduler ───────────────────────────────────────────

function startDreamScheduler(): void {
  setInterval(async () => {
    if (!_dreamOrchestrator || !_memoryProjectionService || !_db) {
      return;
    }

    try {
      // Change-detection: skip if no new action_logs since last run
      const row = _db.getDb().prepare('SELECT COUNT(*) as count FROM action_logs').get() as {
        count: number;
      };
      if (row.count === _lastRunActionLogCount) {
        // No new activity — skip to avoid unnecessary AI API calls
        return;
      }

      // Calculate user idle time
      const idleMinutes = (Date.now() - _lastUserActivityTime) / 60000;
      if (_dreamOrchestrator.shouldRun(idleMinutes) || _dreamOrchestrator.shouldRunDailyEnd()) {
        console.error('[sidecar] Dream orchestrator: starting scheduled run');
        const result = await _dreamOrchestrator.run();
        // Only update counter on a successful run
        _lastRunActionLogCount = row.count;
        if (result.status === 'completed' && result.insights && result.insights.length > 0) {
          const prefs = result.preferences || {};
          _memoryProjectionService.projectFromDream({
            confidence:
              result.insights.reduce((sum, i) => sum + i.confidence, 0) / result.insights.length,
            insights: result.insights.map((i) => ({
              id: i.id,
              category: i.category,
              description: i.description,
              confidence: i.confidence,
              suggestion: i.suggestion,
            })),
            preferredWorkHours: prefs.preferredWorkHours,
            energyPatterns: prefs.energyPatterns,
            scheduleAdherence: prefs.scheduleAdherence,
            productivityTrend: prefs.productivityTrend,
            taskPreferences: prefs.taskPreferences,
          });
          sendNotification('dream.completed', {
            insights: result.insights,
            summary: result.summary,
          });
          console.error(`[sidecar] Dream completed with ${result.insights.length} insights`);

          // Forward buddy adjustments if present
          if (result.buddyAdjustments) {
            if (_buddyCore) {
              _buddyCore.applyDreamInsights(result.buddyAdjustments);
            }
            sendNotification('dream.buddy_adjustments', {
              adjustments: result.buddyAdjustments,
            });
          }
        }
      }
    } catch (err) {
      console.error('[sidecar] Dream scheduler error:', err);
    }
  }, 1_800_000); // every 30 minutes
}

// ── AI Engine Initialization ──────────────────────────────────

function getEnvApiKey(): string {
  return getEnvDeepSeekApiKey();
}

function getStoredApiKey(): string {
  if (!_db) {
    return '';
  }
  try {
    const preferenceService = new PreferenceService(_db.getDb());
    return preferenceService.get('api_key') || '';
  } catch {
    return '';
  }
}

function resolveAiBaseUrl(): string {
  return DEEPSEEK_ANTHROPIC_BASE_URL;
}

function resolveAiProvider(): 'DeepSeek' {
  return DEEPSEEK_PROVIDER;
}

function resolveAiModel(): string {
  return DEEPSEEK_MODEL;
}

function resolveAgentMode(value: unknown, fallback: AgentMode): AgentMode {
  const mode = String(value || fallback).toLowerCase() as AgentMode;
  return AGENT_MODES.has(mode) ? mode : fallback;
}

function getToolsForMode(mode: AgentMode, fastMode = false): AnthropicTool[] {
  if (fastMode) {
    return [];
  }
  if (mode === 'chat' || mode === 'plan') {
    return _aiTools.filter((tool) => {
      const capabilityName = tool.name
        .replace(/__(?=.)/g, '\0')
        .replace(/_/g, '.')
        .replace(/\0/g, '_');
      return !_registry?.get(capabilityName)?.mutating;
    });
  }
  return _aiTools;
}

function initAiEngine(apiKey: string): void {
  _lastConnectivityCheckAt = 0;
  _lastConnectivityResult = { connected: false, reason: 'not checked' };

  // Determine API key: parameter > preference store > env var
  if (!apiKey) {
    apiKey = getEnvApiKey();
  }

  if (!apiKey) {
    _aiClient = null;
    _aiTools = [];
    return;
  }

  _aiClient = new ApiClient({
    apiKey,
    maxTokens: 8192,
    timeoutMs: 120_000,
    maxRetries: 3,
  });

  if (_registry) {
    _aiTools = capabilitiesToTools(_registry);

    // Build the system prompt
    const toolListing = getToolListingPrompt(_registry);
    _aiSystemPrompt = [
      {
        type: 'text',
        text: `你是 EvolveFlow 智能日程助手，一个AI驱动的个人时间管理和生产力伙伴。

## 你的角色
- 帮助用户高效管理日程、任务和事件
- 理解用户的自然语言请求并转换为系统操作
- 主动提供时间管理建议和优化方案
- 在用户完成目标时给予积极反馈

## 核心规则
1. 排程前先了解用户当前的任务和事件状态
2. 尊重用户的工作时间设置
3. 已锁定的任务/事件不可被排程移动
4. 检测时间冲突时主动提醒用户
5. 考虑任务优先级进行排程建议
6. 为用户解释排程决策（为什么这样安排？）
7. 操作完成后简要总结你做了什么
8. 如果用户需求不明确，主动询问澄清
9. 保持友好、鼓励的语气
10. 使用中文与用户交流

${toolListing}

## 排程领域知识
- 任务(time_effect_type): continuous(固定时长灵活安排), deadline(固定截止日期), event_bound(与事件绑定)
- 事件有固定时间范围(start_time, end_time)，可被"锁定"防止重新平衡
- 排程块存储在schedule_blocks表中，由plan_day自动分配
- 重新平衡(rebalance)只移动未锁定的块
- 每个变更操作都被记录在action_logs中，可撤回

## 最佳实践
- 先锁定固定事件（会议、预约），再安排灵活任务
- 任务之间留缓冲时间（避免连续安排）
- 将高优先级任务安排在精力最好的时段
- 使用偏好(preference)存储排程权重

现在，请根据提供的上下文帮助用户。`,
        cache_control: { type: 'ephemeral' },
      },
    ];
  }
}

// ── Main ──────────────────────────────────────────────────────

function main(): void {
  const dataDir = path.join(os.homedir(), '.evolveflow', 'app-data');
  ensureDataDirs(dataDir);
  const db = new EvolveFlowDatabase(path.join(dataDir, 'evolveflow.db'));
  _db = db;
  _registry = createRegistry(db, dataDir);

  // Initialize BuddyCore
  _buddyCore = new BuddyCore();
  try {
    const dbInstance = db.getDb();
    const buddyLevelRow = dbInstance
      .prepare("SELECT value FROM preferences WHERE key = 'buddy_level'")
      .get() as { value?: string } | undefined;
    if (buddyLevelRow?.value && ['full', 'minimal', 'off'].includes(buddyLevelRow.value)) {
      _buddyCore.setLevel(buddyLevelRow.value as 'full' | 'minimal' | 'off');
    }
  } catch {
    /* use default level */
  }

  // Initialize AI engine from stored API key
  try {
    initAiEngine(getStoredApiKey());
  } catch {
    initAiEngine('');
  }

  // Initialize dream orchestrator (requires _aiClient to be set first)
  const memoryDir = path.join(dataDir, 'memories');
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
  }
  const rawDb = db.getDb();
  if (_aiClient) {
    _dreamOrchestrator = new DreamOrchestrator(memoryDir, rawDb, _aiClient);
  }
  const preferenceService = new PreferenceService(rawDb);
  _memoryProjectionService = new MemoryProjectionService(rawDb, preferenceService);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });

  rl.on('line', async (line: string) => {
    try {
      const msg: Message = JSON.parse(line.trim());
      const response = await handleMessage(msg);
      if (response) {
        process.stdout.write(JSON.stringify(response) + '\n');
      }
    } catch (err) {
      const rawPreview = line.length > 200 ? line.slice(0, 200) + '...' : line;
      console.error(`[sidecar] JSON parse error on input (truncated to 200 chars): ${rawPreview}`);
      console.error(
        `[sidecar] Parse error details: ${err instanceof Error ? err.message : String(err)}`
      );
      captureException(err, {
        tags: { source: 'stdin_parse' },
        extra: { rawPreview },
      });
      const traceId = crypto.randomUUID();
      const errorResponse: JsonRpcResponse = {
        jsonrpc: '2.0',
        trace_id: traceId,
        error: { code: -32700, message: 'Parse error', data: { trace_id: traceId } },
      };
      process.stdout.write(JSON.stringify(errorResponse) + '\n');
    }
  });

  rl.on('close', () => {
    process.exit(0);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[sidecar] Unhandled Rejection:', reason);
    captureException(reason, {
      tags: { source: 'unhandledRejection' },
    });
  });

  process.on('uncaughtException', (err) => {
    console.error('[sidecar] Uncaught Exception:', err);
    captureException(err, {
      tags: { source: 'uncaughtException' },
    });
  });

  startReminderPoller();
  startDailySummaryScheduler();
  startDreamScheduler();

  // Re-initialize AI engine when the DeepSeek API key changes.
  const origInvoke = _registry.invoke.bind(_registry);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (_registry as any).invoke = async function (
    name: string,
    input: Record<string, unknown>,
    ctx: Record<string, unknown>
  ) {
    const result = await origInvoke(name, input, ctx as never);
    // If preference changed, re-initialize AI engine
    if (name === 'preference.set') {
      const setKey = (input as { key?: string })?.key;
      if (setKey === 'api_key') {
        const apiKey = (input as { value?: string })?.value || '';
        initAiEngine(apiKey);
        // Also (re)initialize dream orchestrator with the new AI client
        if (_aiClient && !_dreamOrchestrator) {
          _dreamOrchestrator = new DreamOrchestrator(
            path.join(os.homedir(), '.evolveflow', 'app-data', 'memories'),
            rawDb,
            _aiClient
          );
        } else if (_aiClient && _dreamOrchestrator) {
          // Update the orchestrator's API client reference
          _dreamOrchestrator.updateConfig({ modelName: _aiClient.getModel() });
        }
      } else if (setKey === 'buddy_level') {
        const level = (input as { value?: string })?.value;
        if (level && ['full', 'minimal', 'off'].includes(level) && _buddyCore) {
          _buddyCore.setLevel(level as 'full' | 'minimal' | 'off');
        }
      }
    }
    return result;
  };

  sendNotification('system.ready', {
    timestamp: Date.now(),
    pid: process.pid,
    reminderQueueLength: reminderQueue.length,
    aiReady: _aiClient !== null,
  });
}

main();
