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

// ── AI Engine（pi 包内部集成层，runtime 只做胶水）──────────
import type { AgentMode } from './ai/deepseek.js';
import { getEnvDeepSeekApiKey } from './ai/deepseek.js';
import { buildConversationContext } from './ai/context.js';
import {
  bindAiGlue,
  handleAiStream as handleAiStreamPi,
  handleAiChat as handleAiChatPi,
  handleAiCancelStream as handleAiCancelStreamPi,
  resolveApproval as resolveApprovalPi,
  piComplete,
} from './ai/ai-pi-glue.js';
import type { ConversationContext } from './ai/types.js';

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
let _aiCompleterReady = false; // 标记 apiKey 是否已就绪（completer 是无状态的 piComplete）
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
        aiReady: !!getStoredApiKey() || !!getEnvDeepSeekApiKey(),
        sessions: 0,
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

  // ── AI methods（pi Agent 路径，默认）──────────
  if (method === 'ai.chat') {
    if (!_db || !_registry) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        trace_id: traceId,
        error: { code: -32000, message: 'Database not initialized' },
      };
    }
    const r = await handleAiChatPi(params || {});
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      trace_id: traceId,
      result: r.result,
      ...(r.error ? { error: r.error } : {}),
    };
  }

  if (method === 'ai.stream') {
    if (!_db || !_registry) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        trace_id: traceId,
        error: { code: -32000, message: 'Database not initialized' },
      };
    }
    const r = await handleAiStreamPi(params || {}, requestId);
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      trace_id: traceId,
      result: r.result,
      ...(r.error ? { error: r.error } : {}),
    };
  }

  if (method === 'ai.get_sessions') {
    // 会话持久化在 pi 路径的 SessionStore；此处返回空数组占位
    //（前端历史会话列表功能待 SessionStore.list 接入，当前主路径是重启恢复同 sessionId）。
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: { sessions: [] },
    };
  }

  if (method === 'ai.delete_session') {
    // pi 路径的 SessionStore.delete 由 manager.deleteSession 处理；
    // 当前返回成功占位（前端删除即从 UI 移除）。
    const sessionId = (params as { session_id?: string })?.session_id;
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: { deleted: !!sessionId, session_id: sessionId },
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
    const apiKey = getStoredApiKey() || getEnvDeepSeekApiKey();
    if (!apiKey) {
      return {
        jsonrpc: '2.0',
        id: request.id,
        request_id: requestId,
        result: { connected: false, reason: 'AI client not initialized (no API key)' },
      };
    }
    const force = !!(params as { force?: boolean } | undefined)?.force;
    const now = Date.now();
    if (force || now - _lastConnectivityCheckAt > 300_000) {
      try {
        await piComplete([{ role: 'user', content: 'ping' }], 'reply ok', { maxTokens: 8 });
        _lastConnectivityResult = { connected: true };
      } catch (err) {
        _lastConnectivityResult = {
          connected: false,
          reason: `DeepSeek request failed: ${err instanceof Error ? err.message : String(err)}. Check API key, quota, and network.`,
        };
      }
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
    const r = await handleAiCancelStreamPi(params || {});
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      trace_id: traceId,
      result: { ...r.result, session_id: (params as { session_id?: string })?.session_id },
    };
  }

  if (method === 'ai.approve_tool') {
    const approvalId = (params as { approval_id?: string })?.approval_id;
    const allow = !!(params as { allow?: boolean })?.allow;
    const r = resolveApprovalPi(approvalId ?? '', allow);
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: requestId,
      result: { success: r.success, approval_id: approvalId, allow: r.allow },
    };
  }

  if (method === 'ai.suggest_today') {
    return handleAiSuggestTodayPi(request, params || {}, traceId);
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
            modelDisplay: 'DeepSeek-V4-Pro',
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

/**
 * ai.suggest_today：基于今日上下文生成一条日程建议（单次补全，非 agent loop）。
 * 经 pi-backed AiCompleter。返回 { success, data: { suggestion } }。
 */
async function handleAiSuggestTodayPi(
  request: JsonRpcRequest,
  _params: Record<string, unknown>,
  traceId: string
): Promise<JsonRpcResponse> {
  if (!_aiCompleterReady || !_registry || !_db) {
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

    const { text } = await piComplete(
      [
        {
          role: 'user',
          content: `请基于以下 EvolveFlow 今日上下文，生成一条真正有帮助的中文日程建议。不要创建、修改或删除任何数据；不要输出 JSON；不要使用 Markdown；控制在 80 个汉字以内。\n\n${JSON.stringify(compactContext, null, 2)}`,
        },
      ],
      '你是 EvolveFlow 的日程建议引擎。你只输出一条针对当前用户数据的可执行建议，不编造不存在的任务或事件。',
      { maxTokens: 512, temperature: 0.4 }
    );

    const suggestion = text.trim();
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
      result: { success: true, data: { suggestion } },
    };
  } catch (err) {
    console.error(`[sidecar] ai.suggest_today error [trace_id=${traceId}]:`, err);
    return {
      jsonrpc: '2.0',
      id: request.id,
      request_id: request.request_id,
      trace_id: traceId,
      error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
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

    if (_aiCompleterReady && data) {
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

        const aiResult = await piComplete(
          [{ role: 'user', content: prompt }],
          'You are a productivity analysis assistant. Reply ONLY valid JSON.',
          { maxTokens: 500, temperature: 0.7 }
        );

        const text = aiResult.text;

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
  // pi 路径用 DeepSeek 的 OpenAI 兼容端点（非 Anthropic 端点）。
  return 'https://api.deepseek.com';
}

function resolveAiProvider(): 'DeepSeek' {
  return 'DeepSeek';
}

function resolveAiModel(): string {
  // pi-ai 注册表里的 DeepSeek 模型 id（OpenAI 兼容端点）。
  return 'deepseek-v4-pro';
}

function resolveAgentMode(value: unknown, fallback: AgentMode): AgentMode {
  const mode = String(value || fallback).toLowerCase() as AgentMode;
  return AGENT_MODES.has(mode) ? mode : fallback;
}

function initAiEngine(_apiKey: string): void {
  _lastConnectivityCheckAt = 0;
  _lastConnectivityResult = { connected: false, reason: 'not checked' };
  // completer 是无状态的 piComplete（每次内部取最新 key），只需标记就绪。
  _aiCompleterReady = !!(_apiKey || getEnvDeepSeekApiKey());
}

// ── Main ──────────────────────────────────────────────────────

function main(): void {
  const dataDir = path.join(os.homedir(), '.evolveflow', 'app-data');
  ensureDataDirs(dataDir);
  const db = new EvolveFlowDatabase(path.join(dataDir, 'evolveflow.db'));
  _db = db;
  _registry = createRegistry(db, dataDir);

  // 绑定 AI 胶水环境（pi 包集成层，ai.stream/chat/cancel/suggest 都经它）。
  bindAiGlue({
    db,
    registry: _registry,
    sendNotification,
  });

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

  // Initialize AI completer (pi-backed; harness 经 ai-pi-glue 懒建)
  try {
    initAiEngine(getStoredApiKey());
  } catch {
    initAiEngine('');
  }

  // Initialize dream orchestrator（用 piComplete，不再依赖旧 ApiClient）
  const memoryDir = path.join(dataDir, 'memories');
  if (!fs.existsSync(memoryDir)) {
    fs.mkdirSync(memoryDir, { recursive: true });
  }
  const rawDb = db.getDb();
  if (_aiCompleterReady) {
    _dreamOrchestrator = new DreamOrchestrator(memoryDir, rawDb, piComplete);
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

  // Re-initialize AI engine / buddy level when relevant preferences change.
  // Implemented as an onAfterInvoke hook instead of monkey-patching
  // _registry.invoke: the hook is invoked for every caller (sidecar, AI loop,
  // CLI), cannot break the triggering invoke (errors are swallowed inside the
  // registry), and does not depend on install order the way a runtime method
  // reassignment did.
  _registry.onAfterInvoke((name, input) => {
    if (name !== 'preference.set') {
      return;
    }
    const setKey = (input as { key?: string })?.key;
    if (setKey === 'api_key') {
      const apiKey = (input as { value?: string })?.value || '';
      initAiEngine(apiKey);
      // api_key 就绪后建 Dream（completer 是无状态的 piComplete）
      if (_aiCompleterReady && !_dreamOrchestrator && rawDb) {
        _dreamOrchestrator = new DreamOrchestrator(
          path.join(os.homedir(), '.evolveflow', 'app-data', 'memories'),
          rawDb,
          piComplete
        );
      }
    } else if (setKey === 'buddy_level') {
      const level = (input as { value?: string })?.value;
      if (level && ['full', 'minimal', 'off'].includes(level) && _buddyCore) {
        _buddyCore.setLevel(level as 'full' | 'minimal' | 'off');
      }
    }
  });

  sendNotification('system.ready', {
    timestamp: Date.now(),
    pid: process.pid,
    reminderQueueLength: reminderQueue.length,
    aiReady: !!getStoredApiKey() || !!getEnvDeepSeekApiKey(),
  });
}

main();
