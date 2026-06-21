/**
 * harness-manager: pi AgentHarness 生命周期管理 + EvolveFlow 适配。
 *
 * 这是 EvolveFlow 新 AI 路径的核心。它用 pi 的 AgentHarness（L3）替代自研 loop，
 * 把 CapabilityRegistry 经 pi-bridge 暴露成 AgentTool，注入 EvolveFlow 上下文，
 * 并把 pi 的 AgentEvent 流映射成前端已知的 ai.stream_chunk 通知。
 *
 * 设计依据：FUSION-ARCHITECTURE.md（§1.1 选 AgentHarness、§5 五个接缝、§6 sidecar 对接）。
 * 关键修正（C1）：pi-engine.ts 失败是因为绕过 AgentHarness 自己拼 runAgentLoop + streamFn
 * 签名错。这里直接用 AgentHarness.prompt()，streamFn 由 harness 内部正确接线，坑自动消失。
 *
 * feature flag：sidecar 经 EVOLVEFLOW_USE_PI=1 切到本模块，旧路径保留作逃生通道。
 */

import * as path from 'path';
import * as os from 'os';
import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  convertToLlm as defaultConvertToLlm,
} from '@evolveflow/vendor-pi-agent';
import { getModel, streamSimple, type Model } from '@evolveflow/vendor-pi-ai';
import { capabilitiesToAgentTools } from '@evolveflow/pi-bridge';
import type { CapabilityRegistry, CapabilityContext } from '@evolveflow/capabilities';
import type { EvolveFlowDatabase } from '@evolveflow/storage';
import { buildConversationContext } from './context.js';
import { buildEvolveFlowSystemPrompt, filterToolsByMode } from './system-prompt.js';
import { mapAgentEventToStreamChunk } from './event-mapper.js';
import { SessionStore } from './session-store.js';
import { createEvolveFlowNativeTools } from './native-tools.js';
import type { AgentMode } from './deepseek.js';
import type { AiStreamChunk } from './types.js';

/** DeepSeek 在 pi-ai 注册表里的 provider 名（小写，getModel 用）。 */
const PI_DEEPSEEK_PROVIDER = 'deepseek' as const;
/** DeepSeek 在 pi-ai 注册表里的模型 id（已核实真实存在，见 FUSION-ARCHITECTURE C3）。 */
const PI_DEEPSEEK_MODEL_ID = 'deepseek-v4-pro' as const;

/** 单个会话的运行时句柄。 */
interface SessionHandle {
  agent: Agent;
  sessionId: string;
  mode: AgentMode;
  unsubscribe: () => void;
}

export interface HarnessManagerOptions {
  db: EvolveFlowDatabase;
  registry: CapabilityRegistry;
  apiKey: string;
  model?: Model<any>;
  onChunk?: (chunk: AiStreamChunk) => void;
  /** 会话存储（JSONL 持久化）。不提供则不持久化（纯内存）。 */
  sessionStore?: SessionStore;
  /**
   * auto 模式下，对 mutating 能力工具调用前请求用户确认。
   * 回调应：发出 tool_permission_request 通知 → 等待前端响应 → resolve allow。
   * 返回 true 放行，false 则 block。不提供时 auto 模式退化为直接放行（仅靠 action_log 追溯）。
   */
  requestApproval?: (params: {
    sessionId: string;
    toolCallId: string;
    toolName: string; // 原始 capability 名（已 desanitize）
    input: Record<string, unknown>;
  }) => Promise<boolean>;
}

/**
 * HarnessManager 管理多个 Agent 实例（按 sessionId）。
 *
 * 用 pi 的 Agent（L2）而非 AgentHarness（L3）——后者经实测事件不转发（半成品，C7），
 * Agent 的 prompt() 直接经 runAgentLoop + subscribe，事件流转正常（diag-loop 实测验证）。
 * session 持久化暂用 Agent 内置 transcript（内存）；JSONL 持久化留作后续增强。
 */
export class HarnessManager {
  private readonly db: EvolveFlowDatabase;
  private readonly registry: CapabilityRegistry;
  private readonly apiKey: string;
  private readonly model: Model<any>;
  private readonly onChunk?: (chunk: AiStreamChunk) => void;
  private readonly requestApproval?: HarnessManagerOptions['requestApproval'];
  private readonly sessionStore?: SessionStore;
  private readonly handles = new Map<string, SessionHandle>();

  constructor(options: HarnessManagerOptions) {
    this.db = options.db;
    this.registry = options.registry;
    this.apiKey = options.apiKey;
    this.model = options.model ?? getModel(PI_DEEPSEEK_PROVIDER, PI_DEEPSEEK_MODEL_ID);
    this.onChunk = options.onChunk;
    this.requestApproval = options.requestApproval;
    this.sessionStore = options.sessionStore;
  }

  async getOrCreate(
    sessionId: string,
    mode: AgentMode,
    capabilityContext: CapabilityContext
  ): Promise<Agent> {
    const existing = this.handles.get(sessionId);
    if (existing && existing.mode === mode) {
      return existing.agent;
    }
    if (existing) {
      existing.unsubscribe();
      this.handles.delete(sessionId);
    }
    const agent = await this.createAgent(sessionId, mode, capabilityContext);
    return agent;
  }

  /**
   * 发送一条消息，流式事件经 onChunk 推送。返回最终 assistant 文本。
   * Agent.prompt() 返回 void，最终文本从 transcript 末条 assistant message 取。
   */
  async prompt(
    sessionId: string,
    mode: AgentMode,
    message: string,
    capabilityContext: CapabilityContext,
    signal?: AbortSignal
  ): Promise<string> {
    const agent = await this.getOrCreate(sessionId, mode, capabilityContext);
    if (signal?.aborted) {
      throw new Error('aborted');
    }
    if (signal) {
      signal.addEventListener('abort', () => agent.abort(), { once: true });
    }

    // 收集本次运行的最终 assistant 文本。
    // 从 message_end 事件取（state.messages 在工具调用场景可能末尾是 toolResult）。
    let finalText = '';
    const collectUnsub = agent.subscribe((event) => {
      if (event.type === 'message_end') {
        const msg = event.message as {
          role: string;
          content?: Array<{ type: string; text?: string }>;
        };
        if (msg?.role === 'assistant') {
          const t = (msg.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => c.text ?? '')
            .join('');
          if (t) {
            finalText = t;
          } // 取最后一次非空 assistant 文本
        }
      }
    });

    try {
      await agent.prompt(message);
    } finally {
      collectUnsub();
    }
    // 兜底：若事件没捕获到，从 state.messages 取。
    if (!finalText) {
      const messages = agent.state.messages;
      for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant') {
          const t = (m.content ?? [])
            .filter((c) => c.type === 'text')
            .map((c) => ('text' in c ? (c.text ?? '') : ''))
            .join('');
          if (t) {
            return t;
          }
        }
      }
    }
    return finalText;
  }

  async abort(sessionId: string): Promise<void> {
    this.handles.get(sessionId)?.agent.abort();
  }

  async dispose(sessionId: string): Promise<void> {
    const handle = this.handles.get(sessionId);
    if (handle) {
      handle.unsubscribe();
      this.handles.delete(sessionId);
    }
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this.handles.keys()]) {
      await this.dispose(id);
    }
  }

  // ── 内部 ──────────────────────────────────────────────

  private async createAgent(
    sessionId: string,
    mode: AgentMode,
    capabilityContext: CapabilityContext
  ): Promise<Agent> {
    const allCapabilityTools = capabilitiesToAgentTools(this.registry, capabilityContext);
    // OpenAI 兼容端点（DeepSeek 走这个）要求工具名匹配 ^[a-zA-Z0-9_-]+$，
    // 不允许点号。把 'task.create' → 'task__create'，并在 execute 里反查原名。
    // （Anthropic 端点允许点号，但 pi-ai 的 DeepSeek provider 用 OpenAI 端点。）
    const sanitizedTools = allCapabilityTools.map((t) => sanitizeToolName(t));
    // pi 原生只读工具（read/glob）：让 AI 能读用户文件。cwd=home。
    // chat 模式无工具；其他模式可用这些只读工具。
    const nativeTools = mode === 'chat' ? [] : createEvolveFlowNativeTools(os.homedir());
    const activeTools = filterToolsByMode(sanitizedTools, mode).concat(nativeTools);

    // 预构建 system prompt（含 EvolveFlow 上下文）。每条消息前可刷新，这里先建一次。
    const ctx = await buildConversationContext(this.db, this.registry);
    const systemPrompt = buildEvolveFlowSystemPrompt(mode, ctx, activeTools);

    // 持久化：若 sessionStore 提供，加载历史消息（重启恢复）。
    const restoredMessages = this.sessionStore ? await this.sessionStore.load(sessionId) : [];

    const agent = new Agent({
      initialState: {
        systemPrompt,
        model: this.model,
        thinkingLevel: 'off',
        tools: activeTools,
        messages: restoredMessages,
      },
      convertToLlm: defaultConvertToLlm,
      // streamFn 必须同步返回 stream（async/Promise 包装会导致 agent-loop 不迭代）。
      // 直接传 streamSimple 本体，apiKey 经 getApiKey 注入（agent-loop 在每次调用前 resolve）。
      streamFn: streamSimple,
      getApiKey: async () => this.apiKey,
      sessionId,
    });

    // 权限 hook：
    // - chat/plan：block 所有能力工具（最后防线）。
    // - auto：对 mutating 能力工具，经 requestApproval 请求用户确认（跨进程）；
    //   被拒则 block。若未提供 requestApproval，auto 退化为放行（仅 action_log 追溯）。
    // - yolo：全放行。
    // 能力工具经 sanitize 后含双下划线（如 task__create），pi 原生工具无此特征。
    if (mode !== 'yolo') {
      agent.beforeToolCall = async ({ toolCall }) => {
        if (!toolCall.name.includes('__')) {
          return undefined;
        } // 非能力工具，放行
        const origName = desanitizeToolName(toolCall.name);
        const isMutating = isMutatingCapabilityName(origName);
        if (mode === 'chat' || mode === 'plan') {
          return {
            block: true,
            reason: `${mode} 模式不允许执行变更操作（${origName}）。请切换到 auto 或 yolo 模式。`,
          };
        }
        // auto 模式：只读能力放行；mutating 能力请求确认。
        if (mode === 'auto' && isMutating) {
          if (!this.requestApproval) {
            return undefined;
          } // 无确认通道，放行（退化）
          const allow = await this.requestApproval({
            sessionId,
            toolCallId: toolCall.id,
            toolName: origName,
            input: toolCall.arguments as Record<string, unknown>,
          });
          return allow ? undefined : { block: true, reason: `用户拒绝执行工具：${origName}` };
        }
        return undefined;
      };
    }

    // 订阅事件 → ai.stream_chunk。
    const unsubChunk = agent.subscribe((event: AgentEvent) => {
      const chunk = mapAgentEventToStreamChunk(event as unknown as AgentEvent, sessionId);
      if (chunk) {
        this.onChunk?.(chunk);
      }
    });

    // 持久化订阅：每条消息完成时追加到 JSONL（重启可恢复）。
    // 用单独的 subscribe，dispose 时一起取消。
    const unsubPersist = this.sessionStore
      ? agent.subscribe((event: AgentEvent) => {
          if (event.type === 'message_end') {
            // fire-and-forget：持久化不阻断对话流。
            void this.sessionStore!.append(sessionId, event.message as never).catch(() => {});
          }
        })
      : () => {};

    const unsubscribe = () => {
      unsubChunk();
      unsubPersist();
    };

    this.handles.set(sessionId, { agent, sessionId, mode, unsubscribe });
    return agent;
  }

  /** 销毁某 session，同时删 JSONL 文件（供 ai.delete_session 用）。 */
  async deleteSession(sessionId: string): Promise<void> {
    await this.dispose(sessionId);
    if (this.sessionStore) {
      await this.sessionStore.delete(sessionId);
    }
  }

  /** 列出持久化的 session（供 ai.get_sessions 用）。 */
  async listSessions(): Promise<
    Array<{ sessionId: string; messageCount: number; mtimeMs: number }>
  > {
    if (!this.sessionStore) {
      return [];
    }
    return this.sessionStore.list();
  }
}

export function createInMemoryHarnessManager(
  options: Omit<HarnessManagerOptions, never>
): HarnessManager {
  return new HarnessManager(options);
}

/**
 * 把工具名里的非法字符（对 OpenAI 兼容端点）替换掉。
 * OpenAI function name 要求 ^[a-zA-Z0-9_-]+$，不允许点号。
 * 用双下划线替换点号（避免与 capability 名里原有的单下划线冲突，如 plan_day）：
 *   'task.create' → 'task__create'
 *   'schedule.plan_day' → 'schedule__plan_day'
 *
 * execute 闭包不变（pi-bridge 内部用原 capability name 调 registry），
 * 所以只改对外的 name/label。desanitize 时 '__' → '.' 还原。
 */
function sanitizeToolName<T extends AgentTool>(tool: T): T {
  // 先把点号替换成双下划线，其余非法字符（理论上不会出现）替换成单下划线。
  const sanitizedName = tool.name.replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '_');
  return { ...tool, name: sanitizedName, label: tool.label ?? tool.name };
}

/**
 * 把已清洗的工具名还原成原始 capability 名（用于事件上报给前端）。
 * 'task__create' → 'task.create'。基于本 manager 已注册的原始名做反查更可靠，
 * 但 event-mapper 无 registry 访问，故用约定：双下划线 → 点号。
 */
export function desanitizeToolName(name: string): string {
  return name.replace(/__/g, '.');
}

/**
 * 能力名是否为变更操作（auto 模式确认用）。
 * 复用 system-prompt.ts 的同款动作列表（create/update/delete/...）。
 */
function isMutatingCapabilityName(origName: string): boolean {
  const action = origName.split('.').pop() ?? '';
  const mutatingActions = new Set([
    'create',
    'update',
    'delete',
    'cancel',
    'complete',
    'defer',
    'lock',
    'unlock',
    'clear',
    'revert',
    'snooze',
    'run',
    'set',
    'plan_day',
    'plan_range',
    'rebalance',
    'restore',
    'clear_ai_history',
    'clear_learned_state',
  ]);
  return mutatingActions.has(action);
}

// 保留旧导出名，避免破坏 import。
export { Agent as AgentHarness };
