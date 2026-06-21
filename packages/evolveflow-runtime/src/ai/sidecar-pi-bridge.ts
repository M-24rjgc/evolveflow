/**
 * sidecar-pi-bridge: pi Agent 路径接入 sidecar 的 JSON-RPC 层（默认路径）。
 *
 * 本模块负责：
 * - HarnessManager 的懒初始化（首次 AI 调用时建，apiKey 就绪后才建）
 * - ai.stream：建 session → prompt → 流式 chunk 经 onChunk 转 ai.stream_chunk 通知
 * - ai.chat：非流式版本
 * - ai.cancel_stream：agent.abort()
 * - auto 模式的跨进程确认：经 pendingApprovals + ai.approve_tool 路由
 * - AiCompleter：给 Dream 系统等做单次补全（替代旧 ApiClient.createMessage）
 *
 * 见 FUSION-ARCHITECTURE §6（sidecar 对接）。
 */

import { randomUUID } from 'crypto';
import { getModel, completeSimple, type Model } from '@evolveflow/vendor-pi-ai';
import { HarnessManager } from './harness-manager.js';
import { SessionStore, defaultSessionsDir } from './session-store.js';
import type { AiSessionState } from './types.js';
import { resolveAgentMode } from './mode-resolver.js';
import { getEnvDeepSeekApiKey } from './deepseek.js';
import type { AgentMode } from './deepseek.js';
import type { CapabilityRegistry } from '@evolveflow/capabilities';
import type { EvolveFlowDatabase } from '@evolveflow/storage';

/** sidecar 注入的环境：发通知、解决 approval、拿 db/registry。 */
export interface SidecarPiEnv {
  db: EvolveFlowDatabase;
  registry: CapabilityRegistry;
  /** 发 JSON-RPC notification（与 sidecar 的 sendNotification 同签名）。 */
  sendNotification: (method: string, params: Record<string, unknown>, requestId?: string) => void;
  /** 当前请求的 request_id（用于通知关联）。 */
  requestId?: string;
}

/** 待确认的工具调用：approvalId → { resolve, 超时定时器 }。 */
interface PendingApproval {
  resolve: (allow: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingApprovals = new Map<string, PendingApproval>();
const APPROVAL_TIMEOUT_MS = 120_000;

/**
 * auto 模式确认：发 tool_permission_request 通知，返回一个等前端响应的 Promise。
 * 120s 超时自动拒绝（与原 sidecar waitForToolApproval 行为一致）。
 */
function requestApproval(params: {
  sessionId: string;
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const approvalId = `${params.sessionId}:${params.toolCallId}`;
    const timeout = setTimeout(() => {
      if (pendingApprovals.has(approvalId)) {
        pendingApprovals.delete(approvalId);
        resolve(false); // 超时拒绝
      }
    }, APPROVAL_TIMEOUT_MS);
    pendingApprovals.set(approvalId, { resolve, timeout });
    // 发通知给前端，前端弹窗后回 ai.approve_tool。
    _env?.sendNotification(
      'ai.stream_chunk',
      {
        type: 'tool_permission_request',
        session_id: params.sessionId,
        approval_id: approvalId,
        tool_use_id: params.toolCallId,
        tool_name: params.toolName,
        capability_name: params.toolName,
        tool_input: params.input,
        mutating: true,
      },
      _env?.requestId
    );
  });
}

/**
 * 处理 ai.approve_tool：前端用户点了确认/拒绝。
 * 返回 { success, allow }。找不到 approvalId 时 success=false。
 */
export function resolveApprovalPi(
  approvalId: string,
  allow: boolean
): { success: boolean; allow: boolean } {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    return { success: false, allow: false };
  }
  clearTimeout(pending.timeout);
  pendingApprovals.delete(approvalId);
  pending.resolve(allow);
  return { success: true, allow };
}

let _manager: HarnessManager | null = null;
let _env: SidecarPiEnv | null = null;
let _sessionStore: SessionStore | null = null;

/** 绑定 sidecar 环境（sidecar 启动时调一次）。 */
export function bindSidecarPiEnv(env: SidecarPiEnv): void {
  _env = env;
  // 环境变了，重置 manager（下次调用重建）。
  _manager = null;
}

/** 会话存储单例（JSONL 持久化，落 ~/.evolveflow/sessions/）。 */
function getSessionStore(): SessionStore {
  if (!_sessionStore) {
    _sessionStore = new SessionStore(defaultSessionsDir());
  }
  return _sessionStore;
}

/** 获取 manager（暴露给 ai.get_sessions/delete_session 路由用）。 */
export function getPiManager(): HarnessManager | null {
  return _manager;
}

function getApiKey(): string {
  // 优先用 sidecar 已存储的 key（经 env 传入），否则回落到环境变量。
  return process.env.EVOLVEFLOW_AI_KEY || getEnvDeepSeekApiKey();
}

function getManager(): HarnessManager {
  if (!_env) {
    throw new Error('sidecar-pi-bridge 未绑定环境（bindSidecarPiEnv 未调）');
  }
  if (!_manager) {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error('AI engine not initialized. Set API key in Settings.');
    }
    _manager = new HarnessManager({
      db: _env.db,
      registry: _env.registry,
      apiKey,
      sessionStore: getSessionStore(),
      onChunk: (chunk) => {
        if (_env) {
          _env.sendNotification(
            'ai.stream_chunk',
            chunk as unknown as Record<string, unknown>,
            _env.requestId
          );
        }
      },
      // auto 模式跨进程确认（经 pendingApprovals + ai.approve_tool 路由）。
      requestApproval: (p) => requestApproval(p),
    });
  }
  return _manager;
}

/** ai.stream：返回立即 ack，后台流式推送 chunk。与旧 handleAiStream 行为对齐。 */
export async function handleAiStreamPi(
  params: Record<string, unknown>,
  requestId?: string
): Promise<{
  result: { session_id: string; streaming: boolean };
  error?: { code: number; message: string };
}> {
  if (!_env) {
    return {
      result: { session_id: '', streaming: false },
      error: { code: -32000, message: 'PI bridge not initialized' },
    };
  }
  // 临时把本次请求的 requestId 设进 env，让 onChunk 能带上。
  _env.requestId = requestId;

  const message = (params.message as string) || '';
  const sessionId = (params.session_id as string) || randomUUID();
  const mode = resolveAgentMode(params.mode as string, 'auto');

  if (!message.trim()) {
    return {
      result: { session_id: sessionId, streaming: false },
      error: { code: -32602, message: 'message is required' },
    };
  }

  const controller = new AbortController();
  registerStreamController(sessionId, controller);

  // 后台运行，立即返回 ack。
  setTimeout(async () => {
    try {
      await getManager().prompt(
        sessionId,
        mode,
        message,
        {
          actor: 'ai',
          origin: 'ai_page',
          session_id: sessionId,
        },
        controller.signal
      );
      // done chunk 由 agent_end → mapper 发出，这里不重复。
    } catch (err) {
      const isAbort = (err as Error)?.name === 'AbortError' || controller.signal.aborted;
      _env!.sendNotification(
        'ai.stream_chunk',
        {
          type: 'done',
          session_id: sessionId,
          done: true,
          content: isAbort ? 'Stream cancelled by user' : undefined,
          error: isAbort ? undefined : String((err as Error).message ?? err),
        },
        requestId
      );
    } finally {
      unregisterStreamController(sessionId);
    }
  }, 0);

  return { result: { session_id: sessionId, streaming: true } };
}

/** ai.chat（非流式）：跑完收集文本返回。 */
export async function handleAiChatPi(params: Record<string, unknown>): Promise<{
  result: { session_id: string; text: string; error?: string };
  error?: { code: number; message: string };
}> {
  if (!_env) {
    return {
      result: { session_id: '', text: '', error: 'PI bridge not initialized' },
      error: { code: -32000, message: 'PI bridge not initialized' },
    };
  }
  const message = (params.message as string) || '';
  const sessionId = (params.session_id as string) || randomUUID();
  const mode = resolveAgentMode(params.mode as string, 'chat');

  if (!message.trim()) {
    return {
      result: { session_id: sessionId, text: '', error: 'message is required' },
      error: { code: -32602, message: 'message is required' },
    };
  }

  try {
    const text = await getManager().prompt(sessionId, mode, message, {
      actor: 'ai',
      origin: 'ai_page',
      session_id: sessionId,
    });
    return { result: { session_id: sessionId, text } };
  } catch (err) {
    return {
      result: { session_id: sessionId, text: '', error: String((err as Error).message ?? err) },
    };
  }
}

/** ai.cancel_stream。 */
export async function handleAiCancelStreamPi(
  params: Record<string, unknown>
): Promise<{ result: { cancelled: boolean } }> {
  const sessionId = (params.session_id as string) || '';
  if (!sessionId) {
    return { result: { cancelled: false } };
  }
  await getManager()
    .abort(sessionId)
    .catch(() => {
      /* 忽略 */
    });
  const c = streamControllers.get(sessionId);
  if (c) {
    c.abort();
  }
  return { result: { cancelled: true } };
}

/**
 * AI 补全接口：给 Dream / summary 等做单次（非 agent loop）补全。
 * 替代旧 ApiClient.createMessage。Dream 不再直接依赖 ApiClient。
 */
export interface AiCompleter {
  (
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    systemPrompt: string,
    options?: { maxTokens?: number; temperature?: number }
  ): Promise<{ text: string }>;
}

/** DeepSeek 模型（补全用，和 manager 同款）。 */
let _completerModel: Model<any> | null = null;
function getCompleterModel(): Model<any> {
  if (!_completerModel) {
    _completerModel = getModel('deepseek', 'deepseek-v4-pro');
  }
  return _completerModel;
}

/**
 * 创建一个 pi-backed AiCompleter（给 Dream 等用）。
 * 经 pi-ai 的 completeSimple 做单次补全，apiKey 复用 manager 的。
 */
export function createPiCompleter(): AiCompleter {
  return async (messages, systemPrompt, options) => {
    const apiKey = getApiKey();
    if (!apiKey) {
      throw new Error('AI engine not initialized (no API key)');
    }
    const model = getCompleterModel();
    // 转成 pi-ai 的 Message 格式。
    const llmMessages = messages.map((m) => ({
      role: m.role,
      content: [{ type: 'text' as const, text: m.content }],
      timestamp: Date.now(),
    })) as never; // pi-ai 的 Message union 对 AssistantMessage 要求额外字段，
    // 但补全场景输入都是 user/assistant 的简化形态，cast 通过（completeSimple 不校验）。
    const result = await completeSimple(
      model,
      { systemPrompt, messages: llmMessages },
      {
        apiKey,
        ...(options?.maxTokens ? { maxTokens: options.maxTokens } : {}),
      }
    );
    const text = (result.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('');
    return { text };
  };
}

/** pi 路径现在是默认路径（feature flag 已移除）。保留函数避免 sidecar 大改。 */
export function isPiPathEnabled(): boolean {
  return true;
}

// ── 流控制器管理（cancel 用）──────────────────
const streamControllers = new Map<string, AbortController>();
function registerStreamController(sessionId: string, c: AbortController): void {
  streamControllers.set(sessionId, c);
}
function unregisterStreamController(sessionId: string): void {
  streamControllers.delete(sessionId);
}

// 暴露给 sidecar 的 agent mode 解析（统一入口）。
export { resolveAgentMode };
export type { AgentMode, AiSessionState };
