/**
 * EvolveFlow AgentHarness 集成（在 pi 包内部）。
 *
 * 这是 EvolveFlow AI 路径的单一入口：封装 "创建 AgentHarness + pi 原生 Session/jsonl
 * + EvolveFlow 定制注入（DeepSeek key、4 mode 权限、工具名 sanitize、auto 确认、
 * read/glob/PDF 工具、EvolveFlow system prompt）"。
 *
 * 设计原则（F2：pi 是项目源码，直接改；不另起一套写）：
 * - 用 pi 原生 AgentHarness（L3），事件转发 + session 持久化都由 pi 内部处理
 * - 经 AgentHarnessOptions 接缝注入 EvolveFlow 定制
 * - 不在 runtime 侧写 AI 逻辑
 */

import * as path from 'node:path';
import * as os from 'node:os';
import { AgentHarness } from '../agent-harness.ts';
import { Session } from '../session/session.ts';
import { JsonlSessionStorage } from '../session/jsonl-storage.ts';
import { NodeExecutionEnv } from '../env/nodejs.ts';
import type { AgentTool } from '../../types.ts';
import type { AgentHarnessEvent } from '../types.ts';
import { getModel } from '@evolveflow/vendor-pi-ai';
import type { Model } from '@evolveflow/vendor-pi-ai';

import { resolveEvolveFlowMode, isMutatingCapabilityName, type EvolveFlowAgentMode } from './mode.ts';
import { sanitizeToolName, desanitizeToolName, filterToolsByMode } from './tool-sanitizer.ts';
import { createEvolveFlowNativeTools } from './native-tools.ts';
import { buildEvolveFlowSystemPrompt, type EvolveFlowContext } from './system-prompt.ts';

export {
  resolveEvolveFlowMode,
  sanitizeToolName,
  desanitizeToolName,
  filterToolsByMode,
  createEvolveFlowNativeTools,
  buildEvolveFlowSystemPrompt,
};
export type { EvolveFlowAgentMode, EvolveFlowContext };

/** DeepSeek 在 pi-ai 注册表里的标识。 */
const DEEPSEEK_PROVIDER = 'deepseek' as const;
const DEEPSEEK_MODEL_ID = 'deepseek-v4-pro' as const;

/**
 * auto 模式确认回调：工具调用前请求用户确认。
 * 返回 true 放行，false 则 block。不提供时 auto 退化为放行。
 */
export type RequestApprovalFn = (params: {
  sessionId: string;
  toolCallId: string;
  toolName: string; // 原始 capability 名（已 desanitize）
  input: Record<string, unknown>;
}) => Promise<boolean>;

/** 会话列表项（pi 原生 Session 经 JSONL 存储，可列出）。 */
export interface EvolveFlowSessionMeta {
  sessionId: string;
  messageCount: number;
  mtimeMs: number;
}

/** 创建 EvolveFlow 集成所需的输入。 */
export interface CreateEvolveFlowHarnessInput {
  /** DeepSeek API key。 */
  apiKey: string;
  /** 能力工具（来自 CapabilityRegistry，原始名 task.create 等）。 */
  capabilityTools: AgentTool[];
  /** 当前 agent mode。 */
  mode: EvolveFlowAgentMode;
  /** 会话 id（同 id 复用历史；不同 mode 重建）。 */
  sessionId: string;
  /** 当前 EvolveFlow 上下文数据（用于 system prompt 注入）。 */
  context: EvolveFlowContext;
  /** 工作目录（cwd），默认用户 home。 */
  cwd?: string;
  /** 会话 JSONL 存储目录，默认 ~/.evolveflow/sessions。 */
  sessionsDir?: string;
  /** auto 模式确认回调。 */
  requestApproval?: RequestApprovalFn;
  /** 流式事件回调（转发 JSON-RPC notification 用）。 */
  onEvent?: (chunk: EvolveFlowChunk) => void;
  /** 模型（测试用注入；默认 DeepSeek deepseek-v4-pro）。 */
  model?: Model<any>;
}

/**
 * EvolveFlow 流式 chunk（映射自 pi AgentEvent，给前端用）。
 * 与原 runtime 的 AiStreamChunk 形状一致，前端无需改动。
 */
export interface EvolveFlowChunk {
  session_id: string;
  type:
    | 'session_start'
    | 'text_delta'
    | 'thinking_delta'
    | 'tool_use_start'
    | 'tool_result'
    | 'tool_permission_request'
    | 'done'
    | 'error';
  content?: string;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: string;
  error?: string;
  done?: boolean;
}

/** 创建一个 EvolveFlow AgentHarness 实例（含 pi 原生 session 持久化 + 全套定制）。 */
export async function createEvolveFlowHarness(
  input: CreateEvolveFlowHarnessInput,
): Promise<AgentHarness> {
  const cwd = input.cwd ?? os.homedir();
  const sessionsDir = input.sessionsDir ?? path.join(os.homedir(), '.evolveflow', 'sessions');
  const model = input.model ?? getModel(DEEPSEEK_PROVIDER, DEEPSEEK_MODEL_ID);
  const mode = input.mode;

  // 1. pi 原生 Session + JsonlSessionStorage（持久化由 pi 内部处理）
  const env = new NodeExecutionEnv({ cwd });
  const sessionPath = path.join(sessionsDir, `${sanitizeSessionId(input.sessionId)}.jsonl`);
  const storage = await openOrCreateSession(env, sessionPath, cwd, input.sessionId);
  const session = new Session(storage);

  // 2. 工具组装：能力工具（sanitize 名）+ pi 原生 read/glob
  const sanitizedCapabilityTools = input.capabilityTools.map(sanitizeToolName);
  const nativeTools = mode === 'chat' ? [] : createEvolveFlowNativeTools(cwd);
  const allTools = [...sanitizedCapabilityTools, ...nativeTools];

  // 3. 按 mode 过滤激活工具
  const activeTools = filterToolsByMode(sanitizedCapabilityTools, mode).concat(nativeTools);
  const activeToolNames = activeTools.map((t) => t.name);

  // 4. AgentHarness（pi 原生，接缝注入）
  const harness = new AgentHarness({
    env,
    session,
    model,
    tools: allTools,
    activeToolNames,
    getApiKeyAndHeaders: async () => ({ apiKey: input.apiKey }),
    systemPrompt: ({ activeTools: toolsForPrompt }) =>
      buildEvolveFlowSystemPrompt(mode, input.context, toolsForPrompt),
  });

  // 5. 权限 hook（4 mode 矩阵，经 harness.on('tool_call')）
  registerPermissionHook(harness, mode, input.sessionId, input.requestApproval);

  // 6. 事件订阅 → EvolveFlowChunk（转发 JSON-RPC）
  harness.subscribe((event) => {
    const chunk = mapAgentEventToChunk(event as AgentHarnessEvent, input.sessionId);
    if (chunk) input.onEvent?.(chunk);
  });

  return harness;
}

// ── 内部辅助 ──────────────────────────────────────────

/** 会话 id 清洗（防路径穿越，只允许字母数字-）。 */
function sanitizeSessionId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** 打开或创建 pi 原生 JSONL session 文件。 */
async function openOrCreateSession(
  env: NodeExecutionEnv,
  filePath: string,
  cwd: string,
  sessionId: string,
): Promise<JsonlSessionStorage> {
  // 确保目录存在
  try {
    const fs = await import('node:fs/promises');
    await fs.mkdir(path.dirname(filePath), { recursive: true });
  } catch {
    /* 忽略，open/create 会再报 */
  }
  const existsResult = await env.exists(filePath);
  const exists = existsResult.ok && existsResult.value;
  return exists
    ? JsonlSessionStorage.open(env, filePath)
    : JsonlSessionStorage.create(env, filePath, { cwd, sessionId });
}

/**
 * 注册权限 hook（harness.on('tool_call')）。
 * - chat/plan：block 所有能力工具
 * - auto：mutating 能力工具请求确认
 * - yolo：全放行
 */
function registerPermissionHook(
  harness: AgentHarness,
  mode: EvolveFlowAgentMode,
  sessionId: string,
  requestApproval?: RequestApprovalFn,
): void {
  if (mode === 'yolo') return;

  harness.on('tool_call', async (event) => {
    const toolName = event.toolName;
    // 能力工具含双下划线（sanitize 后）；原生 read/glob 无此特征，放行
    if (!toolName.includes('__')) return undefined;
    const origName = desanitizeToolName(toolName);
    const mutating = isMutatingCapabilityName(origName);

    if (mode === 'chat' || mode === 'plan') {
      return {
        block: true,
        reason: `${mode} 模式不允许执行变更操作（${origName}）。请切换到 auto 或 yolo 模式。`,
      };
    }

    // auto：只读放行，mutating 请求确认
    if (mode === 'auto' && mutating) {
      if (!requestApproval) return undefined;
      const allow = await requestApproval({
        sessionId,
        toolCallId: event.toolCallId,
        toolName: origName,
        input: event.input,
      });
      return allow ? undefined : { block: true, reason: `用户拒绝执行工具：${origName}` };
    }
    return undefined;
  });
}

/** pi AgentEvent → EvolveFlowChunk（前端契约）。 */
function mapAgentEventToChunk(
  event: AgentHarnessEvent,
  sessionId: string,
): EvolveFlowChunk | null {
  const base = { session_id: sessionId };

  switch (event.type) {
    case 'agent_start':
      return { ...base, type: 'session_start', content: '会话已开始' };

    case 'message_end': {
      const msg = event.message as { role: string; content?: Array<{ type: string; text?: string }> };
      if (msg?.role !== 'assistant') return null;
      const text = (msg.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      if (!text) return null;
      return { ...base, type: 'text_delta', content: text };
    }

    case 'tool_execution_start':
      return {
        ...base,
        type: 'tool_use_start',
        tool_name: desanitizeToolName(event.toolName),
        tool_use_id: event.toolCallId,
        tool_input: event.args as Record<string, unknown>,
      };

    case 'tool_execution_end': {
      const result = event.result as { content?: Array<{ type: string; text?: string }> };
      const text = (result.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      return {
        ...base,
        type: 'tool_result',
        tool_name: desanitizeToolName(event.toolName),
        tool_use_id: event.toolCallId,
        tool_result: text,
        error: event.isError ? text : undefined,
      };
    }

    case 'agent_end':
      return { ...base, type: 'done', done: true };

    default:
      return null;
  }
}
