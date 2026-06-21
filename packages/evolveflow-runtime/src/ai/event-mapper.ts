/**
 * pi AgentEvent → EvolveFlow AiStreamChunk 映射器。
 *
 * 前端只认 ai.stream_chunk 通知，payload 有 9 种 type（types.ts:217-240）。
 * pi 的事件更细（agent_start/turn_start/message_start/message_update/message_end/
 * tool_execution_start/tool_execution_update/tool_execution_end/turn_end/agent_end）。
 * 这里把它们映射成前端已有的 chunk 类型，保持前端契约不变（见 FUSION-ARCHITECTURE §2.4）。
 */

import type { AgentEvent } from '@evolveflow/vendor-pi-agent';
import type { AiStreamChunk } from './types.js';
import { desanitizeToolName } from './harness-manager.js';

/** 还原工具名给前端（'task__create' → 'task.create'）。 */
function origToolName(name: string): string {
  return desanitizeToolName(name);
}

/**
 * 把一个 pi 事件映射成 AiStreamChunk（或 null 表示前端不需要这个事件）。
 *
 * 文本字段注意：pi 的 message_update 事件里，累积文本在 `event.message.content[0].text`
 * （assistantMessageEvent.delta 只是增量片段，不带完整字段名 text）。所以从 event.message 读。
 */
export function mapAgentEventToStreamChunk(
  event: AgentEvent,
  sessionId: string
): AiStreamChunk | null {
  const base = { session_id: sessionId };

  switch (event.type) {
    // ── 会话开始 ──────────────────────────────
    case 'agent_start':
      return { ...base, type: 'session_start', content: '会话已开始' };

    // ── 文本流（assistant 消息增量）──────────
    case 'message_update': {
      // message_update 携带累积的 message（含最新文本）。读 message.content 的 text 块。
      const msg = event.message as { content?: Array<{ type: string; text?: string }> };
      const textBlock = msg?.content?.find((c) => c.type === 'text');
      if (!textBlock || !textBlock.text) {
        return null;
      }
      // 用整条文本做增量推送：前端累加会有重复，改用 assistantMessageEvent.delta 做纯增量。
      // 但 delta 结构不稳定，安全起见这里只在 text_end 时推一次完整文本。
      return null;
    }

    case 'message_end': {
      const msg = event.message as {
        role: string;
        content?: Array<{ type: string; text?: string }>;
      };
      // 只对 assistant 消息发文本；user/toolResult 消息由其他事件覆盖。
      if (msg?.role !== 'assistant') {
        return null;
      }
      const text = (msg.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      if (!text) {
        return null;
      }
      return { ...base, type: 'text_delta', content: text };
    }

    // ── 工具调用开始 ──────────────────────────
    case 'tool_execution_start':
      return {
        ...base,
        type: 'tool_use_start',
        tool_name: origToolName(event.toolName),
        tool_use_id: event.toolCallId,
        tool_input: event.args as Record<string, unknown>,
      };

    // ── 工具结果 ──────────────────────────────
    case 'tool_execution_end': {
      const result = event.result as {
        content?: Array<{ type: string; text?: string }>;
      };
      const text = (result.content ?? [])
        .filter((c) => c.type === 'text')
        .map((c) => c.text ?? '')
        .join('');
      return {
        ...base,
        type: 'tool_result',
        tool_name: origToolName(event.toolName),
        tool_use_id: event.toolCallId,
        tool_result: text,
        error: event.isError ? text : undefined,
      };
    }

    // ── 结束 ──────────────────────────────────
    case 'agent_end':
      return { ...base, type: 'done', done: true };

    // ── 其余事件前端暂不需要 ──────────────────
    case 'turn_start':
    case 'turn_end':
    case 'message_start':
    case 'tool_execution_update':
      return null;

    default:
      return null;
  }
}
