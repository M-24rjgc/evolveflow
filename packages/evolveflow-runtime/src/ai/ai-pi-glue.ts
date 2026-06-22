/**
 * runtime 侧极薄胶水：把 pi 包的 createEvolveFlowHarness 接到 sidecar 的 JSON-RPC 层。
 *
 * 所有 AI 逻辑都在 pi 包内部（evolveflow-vendor-pi-agent/src/harness/evolveflow/）。
 * 本文件只做：创建 harness、转发流式事件为 notification、auto 模式确认、单次补全。
 */

import { randomUUID } from 'crypto';
import {
  createEvolveFlowHarness,
  resolveEvolveFlowMode,
  type EvolveFlowAgentMode,
  type EvolveFlowChunk,
  type EvolveFlowContext,
  type RequestApprovalFn,
} from '@evolveflow/vendor-pi-agent';
import { getModel, completeSimple, type Model } from '@evolveflow/vendor-pi-ai';
import type { AgentHarness } from '@evolveflow/vendor-pi-agent';
import type { CapabilityRegistry, CapabilityContext } from '@evolveflow/capabilities';
import type { EvolveFlowDatabase } from '@evolveflow/storage';
import { capabilitiesToAgentTools } from '@evolveflow/pi-bridge';
import { buildConversationContext } from './context.js';
import type { AgentMode } from './deepseek.js';

/** 单次补全接口（给 Dream / summary 用）。Dream 不直接依赖具体 AI 实现。 */
export type AiCompleter = (
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
  options?: { maxTokens?: number; temperature?: number }
) => Promise<{ text: string }>;

/** sidecar 注入：发通知、拿 db/registry。 */
export interface AiGlueEnv {
  db: EvolveFlowDatabase;
  registry: CapabilityRegistry;
  sendNotification: (method: string, params: Record<string, unknown>, requestId?: string) => void;
  requestId?: string;
}

/** 待确认的工具调用：approvalId → { resolve, 超时定时器 }。 */
interface PendingApproval {
  resolve: (allow: boolean) => void;
  timeout: ReturnType<typeof setTimeout>;
}
const pendingApprovals = new Map<string, PendingApproval>();
const APPROVAL_TIMEOUT_MS = 120_000;

let _env: AiGlueEnv | null = null;
const harnesses = new Map<string, AgentHarness>();
const sessionsMeta = new Map<string, { mode: EvolveFlowAgentMode }>();

/** DeepSeek 模型（completer 用）。 */
let _completerModel: Model<any> | null = null;
function getCompleterModel(): Model<any> {
  if (!_completerModel) {
    _completerModel = getModel('deepseek', 'deepseek-v4-pro');
  }
  return _completerModel;
}

/** 绑定 sidecar 环境（启动时调一次）。 */
export function bindAiGlue(env: AiGlueEnv): void {
  _env = env;
}

function apiKey(): string {
  return process.env.EVOLVEFLOW_AI_KEY || process.env.DEEPSEEK_API_KEY || '';
}

/** 获取或创建一个 session 的 harness。 */
async function getHarness(
  sessionId: string,
  mode: EvolveFlowAgentMode,
  capabilityCtx: CapabilityContext
): Promise<AgentHarness> {
  const existing = sessionsMeta.get(sessionId);
  if (harnesses.has(sessionId) && existing?.mode === mode) {
    return harnesses.get(sessionId)!;
  }
  // 不同 mode 重建（释放旧的）
  if (harnesses.has(sessionId)) {
    harnesses.delete(sessionId);
  }
  if (!_env) {
    throw new Error('AiGlue 未绑定环境');
  }
  const key = apiKey();
  if (!key) {
    throw new Error('AI engine not initialized. Set API key in Settings.');
  }

  const ctx = await buildConversationContext(_env.db, _env.registry);
  // 把 runtime 的 ConversationContext 形状对齐 pi 包的 EvolveFlowContext
  const evolveflowCtx: EvolveFlowContext = ctx as unknown as EvolveFlowContext;
  const capabilityTools = capabilitiesToAgentTools(_env.registry, capabilityCtx);

  const harness = await createEvolveFlowHarness({
    apiKey: key,
    capabilityTools,
    mode,
    sessionId,
    context: evolveflowCtx,
    requestApproval: makeRequestApproval(),
    onEvent: (chunk: EvolveFlowChunk) => {
      if (_env) {
        _env.sendNotification(
          'ai.stream_chunk',
          chunk as unknown as Record<string, unknown>,
          _env.requestId
        );
      }
    },
  });
  harnesses.set(sessionId, harness);
  sessionsMeta.set(sessionId, { mode });
  return harness;
}

/** auto 模式确认：发 tool_permission_request 通知，等用户响应。 */
function makeRequestApproval(): RequestApprovalFn {
  return (params) =>
    new Promise<boolean>((resolve) => {
      const approvalId = `${params.sessionId}:${params.toolCallId}`;
      const timeout = setTimeout(() => {
        if (pendingApprovals.has(approvalId)) {
          pendingApprovals.delete(approvalId);
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);
      pendingApprovals.set(approvalId, { resolve, timeout });
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

/** 处理 ai.approve_tool：前端用户响应。 */
export function resolveApproval(
  approvalId: string,
  allow: boolean
): {
  success: boolean;
  allow: boolean;
} {
  const pending = pendingApprovals.get(approvalId);
  if (!pending) {
    return { success: false, allow: false };
  }
  clearTimeout(pending.timeout);
  pendingApprovals.delete(approvalId);
  pending.resolve(allow);
  return { success: true, allow };
}

/** ai.stream：返回 ack，后台流式推送 chunk。 */
export async function handleAiStream(
  params: Record<string, unknown>,
  requestId?: string
): Promise<{
  result: { session_id: string; streaming: boolean };
  error?: { code: number; message: string };
}> {
  if (!_env) {
    return {
      result: { session_id: '', streaming: false },
      error: { code: -32000, message: 'AiGlue not initialized' },
    };
  }
  _env.requestId = requestId;
  const message = (params.message as string) || '';
  const sessionId = (params.session_id as string) || randomUUID();
  const mode = resolveEvolveFlowMode(params.mode, 'auto') as AgentMode as EvolveFlowAgentMode;

  if (!message.trim()) {
    return {
      result: { session_id: sessionId, streaming: false },
      error: { code: -32602, message: 'message is required' },
    };
  }

  const capabilityCtx: CapabilityContext = {
    actor: 'ai',
    origin: 'ai_page',
    session_id: sessionId,
  };

  // 后台运行，立即返回 ack。
  setTimeout(async () => {
    try {
      const harness = await getHarness(sessionId, mode, capabilityCtx);
      await harness.prompt(message);
    } catch (err) {
      _env?.sendNotification(
        'ai.stream_chunk',
        {
          type: 'error',
          session_id: sessionId,
          error: String((err as Error).message ?? err),
        },
        requestId
      );
      _env?.sendNotification(
        'ai.stream_chunk',
        { type: 'done', session_id: sessionId, done: true },
        requestId
      );
    }
  }, 0);

  return { result: { session_id: sessionId, streaming: true } };
}

/** ai.chat（非流式）：跑完收集文本返回。 */
export async function handleAiChat(
  params: Record<string, unknown>
): Promise<{
  result: { session_id: string; text: string; error?: string };
  error?: { code: number; message: string };
}> {
  if (!_env) {
    return {
      result: { session_id: '', text: '', error: 'AiGlue not initialized' },
      error: { code: -32000, message: 'AiGlue not initialized' },
    };
  }
  const message = (params.message as string) || '';
  const sessionId = (params.session_id as string) || randomUUID();
  const mode = resolveEvolveFlowMode(params.mode, 'chat') as AgentMode as EvolveFlowAgentMode;

  if (!message.trim()) {
    return {
      result: { session_id: sessionId, text: '', error: 'message is required' },
      error: { code: -32602, message: 'message is required' },
    };
  }

  const capabilityCtx: CapabilityContext = {
    actor: 'ai',
    origin: 'ai_page',
    session_id: sessionId,
  };
  try {
    const harness = await getHarness(sessionId, mode, capabilityCtx);
    const assistantMsg = await harness.prompt(message);
    const text = (assistantMsg.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => ('text' in c ? c.text : ''))
      .join('');
    return { result: { session_id: sessionId, text } };
  } catch (err) {
    return {
      result: { session_id: sessionId, text: '', error: String((err as Error).message ?? err) },
    };
  }
}

/** ai.cancel_stream：abort 指定 session。 */
export async function handleAiCancelStream(
  params: Record<string, unknown>
): Promise<{ result: { cancelled: boolean } }> {
  const sessionId = (params.session_id as string) || '';
  if (!sessionId) {
    return { result: { cancelled: false } };
  }
  const harness = harnesses.get(sessionId);
  if (harness) {
    await harness.abort().catch(() => {});
  }
  return { result: { cancelled: true } };
}

/**
 * 单次补全（给 Dream / summary / connectivity 用）。
 * 替代旧 ApiClient.createMessage。
 */
export async function piComplete(
  messages: Array<{ role: 'user' | 'assistant'; content: string }>,
  systemPrompt: string,
  options?: { maxTokens?: number; temperature?: number }
): Promise<{ text: string }> {
  const key = apiKey();
  if (!key) {
    throw new Error('AI engine not initialized (no API key)');
  }
  const model = getCompleterModel();
  const llmMessages = messages.map((m) => ({
    role: m.role,
    content: [{ type: 'text' as const, text: m.content }],
    timestamp: Date.now(),
  })) as never;
  const result = await completeSimple(
    model,
    { systemPrompt, messages: llmMessages },
    { apiKey: key, ...(options?.maxTokens ? { maxTokens: options.maxTokens } : {}) }
  );
  const text = (result.content ?? [])
    .filter((c) => c.type === 'text')
    .map((c) => ('text' in c ? c.text : ''))
    .join('');
  return { text };
}
