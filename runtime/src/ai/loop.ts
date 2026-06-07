/**
 * Core AI conversation loop.
 *
 * Manages:
 *  - Multi-turn conversation with DeepSeek-V4-Flash
 *  - Automatic tool-call → execute → result → continue cycles
 *  - Streaming response emission via callbacks
 *  - Context window auto-compaction
 *  - Token budget tracking
 *  - Error recovery with graceful degradation
 *
 * Architecture references:
 *  - OCC src/query.ts pattern (conversation loop structure)
 *  - OCC src/services/tools/toolOrchestration.ts (multi-tool pattern)
 *  - OCC src/services/compact/ (auto-compaction strategy)
 *
 * Zero OCC code dependency — all patterns reimplemented for EvolveFlow.
 */

import type {
  MessageParam,
  ContentBlock,
  ToolUseBlock,
  ToolResultBlock,
  AiSessionState,
  AiStreamChunk,
  ConversationContext,
  SystemMessageParam,
  UsageInfo,
} from './types.js';
import type { AnthropicTool } from './types.js';
import { toolToCapabilityName } from './tools.js';
import type { ApiClient } from './client.js';
import type { CapabilityRegistry } from '@evolveflow/capabilities';
import type { Origin } from '@evolveflow/domain';

// ── Configuration ──────────────────────────────────────────────

interface ConversationConfig {
  maxTurns?: number;
  tokenBudget?: number;
  compactAtTokens?: number;
  thinking?: { type: 'enabled'; budget_tokens?: number } | { type: 'disabled' };
  maxTokens?: number;
  temperature?: number;
  systemPrompt: SystemMessageParam[];
  tools: AnthropicTool[];
  context: ConversationContext;
  client: ApiClient;
  registry: CapabilityRegistry;
  sessionId: string;
  toolOrigin?: Origin;
  confirmToolUse?: (
    request: ToolPermissionRequest
  ) => Promise<ToolPermissionDecision | boolean> | ToolPermissionDecision | boolean;
  onChunk: (chunk: AiStreamChunk) => void;
  abortSignal?: AbortSignal;
}

export interface ToolPermissionRequest {
  sessionId: string;
  approvalId: string;
  toolUseId: string;
  toolName: string;
  capabilityName: string;
  input: Record<string, unknown>;
  mutating: boolean;
}

export interface ToolPermissionDecision {
  allow: boolean;
  reason?: string;
  requiresApproval?: boolean;
}

const DEFAULT_MAX_TURNS = 15;
const DEFAULT_TOKEN_BUDGET = 180_000;
const DEFAULT_COMPACT_AT = 120_000;
const ESTIMATED_CHARS_PER_TOKEN = 4;
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour — sessions inactive longer are evicted
const MAX_SESSIONS = 50;
const MAX_CONTINUATIONS = 2;

// ── Session Store ──────────────────────────────────────────────

const sessions = new Map<string, AiSessionState>();

export function getSession(sessionId: string): AiSessionState | undefined {
  return sessions.get(sessionId);
}

/**
 * Evict stale sessions and enforce the maximum session limit.
 * - TTL eviction: sessions with lastActivityAt older than 1 hour are removed.
 * - Count eviction: if still over 50, the oldest sessions are evicted first.
 */
function cleanupSessions(): void {
  const now = Date.now();
  for (const [id, session] of sessions) {
    if (now - session.lastActivityAt > SESSION_TTL_MS) {
      sessions.delete(id);
    }
  }
  if (sessions.size > MAX_SESSIONS) {
    const sorted = Array.from(sessions.entries()).sort(
      ([, a], [, b]) => a.lastActivityAt - b.lastActivityAt
    );
    const toDelete = sorted.slice(0, sorted.length - MAX_SESSIONS);
    for (const [id] of toDelete) {
      sessions.delete(id);
    }
  }
}

export function createSession(sessionId: string, model: string): AiSessionState {
  // Run cleanup before creating any new session
  cleanupSessions();

  const state: AiSessionState = {
    sessionId,
    messages: [],
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    totalTokens: { input_tokens: 0, output_tokens: 0 },
    model,
  };
  sessions.set(sessionId, state);
  return state;
}

export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}

export function getAllSessions(): AiSessionState[] {
  return Array.from(sessions.values());
}

// ── Main Conversation Loop ─────────────────────────────────────

export async function* runConversation(
  userMessage: string,
  config: ConversationConfig
): AsyncGenerator<AiStreamChunk> {
  const {
    maxTurns = DEFAULT_MAX_TURNS,
    tokenBudget = DEFAULT_TOKEN_BUDGET,
    compactAtTokens = DEFAULT_COMPACT_AT,
    thinking,
    maxTokens,
    temperature,
    systemPrompt,
    tools,
    context,
    client,
    registry,
    sessionId,
    toolOrigin = 'ai_page',
    confirmToolUse,
    onChunk,
    abortSignal,
  } = config;

  // Get or create session state
  let session = sessions.get(sessionId);
  if (!session) {
    session = createSession(sessionId, client.getModel());
  }

  // Add user message to history
  session.messages.push({ role: 'user', content: userMessage });
  session.lastActivityAt = Date.now();

  // Emit session start
  const startChunk: AiStreamChunk = {
    type: 'session_start',
    session_id: sessionId,
    content: `会话已开始，共 ${session.messages.length} 条消息`,
  };
  yield startChunk;
  onChunk(startChunk); // Dual-output: yield for generator consumers (pipeline chaining), onChunk callback for sidecar.ts consumers

  let turnCount = 0;
  let continuationCount = 0; // Tracks auto-continuations for max_tokens recovery

  while (turnCount < maxTurns) {
    // Check abort
    if (abortSignal?.aborted) {
      const doneChunk: AiStreamChunk = { type: 'done', session_id: sessionId, done: true };
      yield doneChunk;
      onChunk(doneChunk);
      return;
    }

    turnCount++;

    // Build the full system prompt with context EARLY so token estimation
    // includes the context block (tasks, events, dream insights, etc.).
    const fullSystemPrompt = buildSystemPrompt(systemPrompt, context);

    // Auto-compact if needed
    const estimatedTokens = estimateTokens(session.messages, fullSystemPrompt);
    if (estimatedTokens > compactAtTokens) {
      compactConversation(session);
    }

    // Hard-enforce token budget: if still over budget after compaction, do aggressive truncation
    const estimatedAfterCompact = estimateTokens(session.messages, fullSystemPrompt);
    if (estimatedAfterCompact > tokenBudget) {
      aggressiveCompact(session);
    }

    try {
      // Stream response from DeepSeek.
      const stream = client.streamMessage(
        session.messages,
        tools,
        fullSystemPrompt,
        {
          ...(thinking ? { thinking } : { thinking: client.getThinkingConfig(2000) }),
          ...(maxTokens ? { maxTokens } : {}),
          ...(temperature !== undefined ? { temperature } : {}),
        },
        abortSignal
      );

      // Accumulators for this turn
      let currentTextBlock = '';
      const currentThinkingBlocks = new Map<
        number,
        {
          thinking: string;
          signature: string;
        }
      >();
      const currentToolBlocks: Map<
        number,
        {
          id: string;
          name: string;
          inputJson: string;
        }
      > = new Map();

      let stopReason: string | null = null;
      let usage: UsageInfo | null = null;

      for await (const event of stream) {
        if (abortSignal?.aborted) {
          break;
        }

        switch (event.type) {
          case 'message_start': {
            if (event.message?.usage) {
              usage = event.message.usage;
            }
            break;
          }

          case 'content_block_start': {
            const block = event.content_block;
            if (block.type === 'text') {
              currentTextBlock = '';
            } else if (block.type === 'tool_use') {
              currentToolBlocks.set(event.index, {
                id: block.id,
                name: block.name,
                inputJson: '',
              });

              const toolChunk: AiStreamChunk = {
                type: 'tool_use_start',
                session_id: sessionId,
                tool_name: block.name,
                tool_use_id: block.id,
              };
              yield toolChunk;
              onChunk(toolChunk);
            } else if (block.type === 'thinking') {
              currentThinkingBlocks.set(event.index, {
                thinking: block.thinking || '',
                signature: block.signature || '',
              });
            }
            break;
          }

          case 'content_block_delta': {
            const delta = event.delta;
            if (delta.type === 'text_delta') {
              currentTextBlock += delta.text;
              const textChunk: AiStreamChunk = {
                type: 'text_delta',
                session_id: sessionId,
                content: delta.text,
              };
              yield textChunk;
              onChunk(textChunk);
            } else if (delta.type === 'input_json_delta') {
              const existing = currentToolBlocks.get(event.index);
              if (existing) {
                existing.inputJson += delta.partial_json;
              }
            } else if (delta.type === 'thinking_delta') {
              const existing = currentThinkingBlocks.get(event.index) || {
                thinking: '',
                signature: '',
              };
              existing.thinking += delta.thinking;
              currentThinkingBlocks.set(event.index, existing);
              const thinkChunk: AiStreamChunk = {
                type: 'thinking_delta',
                session_id: sessionId,
                content: delta.thinking,
              };
              yield thinkChunk;
              onChunk(thinkChunk);
            } else if (delta.type === 'signature_delta') {
              const existing = currentThinkingBlocks.get(event.index) || {
                thinking: '',
                signature: '',
              };
              existing.signature = delta.signature;
              currentThinkingBlocks.set(event.index, existing);
            }
            break;
          }

          case 'content_block_stop': {
            // Text block complete — nothing special needed
            break;
          }

          case 'message_delta': {
            if (event.delta?.stop_reason) {
              stopReason = event.delta.stop_reason;
            }
            if (event.usage) {
              usage = { ...(usage || { input_tokens: 0, output_tokens: 0 }), ...event.usage };
            }
            break;
          }

          case 'message_stop': {
            // Validate: stop_reason and usage should have been captured from message_delta
            if (!stopReason) {
              console.warn(
                `[loop] message_stop received but stop_reason was not set (session: ${sessionId})`
              );
            }
            if (!usage) {
              console.warn(
                `[loop] message_stop received but usage data was not captured (session: ${sessionId})`
              );
            }
            break;
          }

          case 'error': {
            const errChunk: AiStreamChunk = {
              type: 'error',
              session_id: sessionId,
              error: event.error?.message || 'Unknown API error',
            };
            yield errChunk;
            onChunk(errChunk);
            break;
          }
        }
      }

      // Update session token usage
      if (usage) {
        session.totalTokens.input_tokens += usage.input_tokens || 0;
        session.totalTokens.output_tokens += usage.output_tokens || 0;
      }

      // Collect assistant response content blocks
      const assistantContent: ContentBlock[] = [];

      for (const [, thinkingBlock] of Array.from(currentThinkingBlocks.entries()).sort(
        ([a], [b]) => a - b
      )) {
        if (thinkingBlock.thinking) {
          assistantContent.push({
            type: 'thinking',
            thinking: thinkingBlock.thinking,
            signature: thinkingBlock.signature,
          });
        }
      }

      if (currentTextBlock) {
        assistantContent.push({ type: 'text', text: currentTextBlock });
      }

      // Process tool calls
      const toolResults: ToolResultBlock[] = [];

      for (const [, toolBlock] of currentToolBlocks) {
        let parsedInput: Record<string, unknown> = {};
        try {
          parsedInput = JSON.parse(toolBlock.inputJson || '{}');
        } catch {
          parsedInput = {};
        }

        assistantContent.push({
          type: 'tool_use',
          id: toolBlock.id,
          name: toolBlock.name,
          input: parsedInput,
        });

        // Execute the tool via CapabilityRegistry
        const capabilityName = toolToCapabilityName(toolBlock.name);
        // e.g. "task_create" → "task.create"
        const capability = registry.list().find((cap) => cap.name === capabilityName);
        const mutating = !!capability?.mutating;

        if (confirmToolUse) {
          const approvalId = `${sessionId}:${toolBlock.id}`;
          const permissionRequest = {
            sessionId,
            approvalId,
            toolUseId: toolBlock.id,
            toolName: toolBlock.name,
            capabilityName,
            input: parsedInput,
            mutating,
          };
          const rawDecision = confirmToolUse(permissionRequest);
          const shouldEmitApproval = shouldEmitToolApproval(rawDecision, mutating);
          if (shouldEmitApproval) {
            const permissionChunk: AiStreamChunk = {
              type: 'tool_permission_request',
              session_id: sessionId,
              approval_id: approvalId,
              tool_use_id: toolBlock.id,
              tool_name: toolBlock.name,
              capability_name: capabilityName,
              tool_input: parsedInput,
              mutating,
            };
            yield permissionChunk;
            onChunk(permissionChunk);
          }
          const decision = await resolveToolPermission(rawDecision);

          if (!decision.allow) {
            const denyReason = decision.reason || `Tool execution denied: ${capabilityName}`;
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolBlock.id,
              content: denyReason,
              is_error: true,
            });

            const deniedChunk: AiStreamChunk = {
              type: 'tool_result',
              session_id: sessionId,
              tool_use_id: toolBlock.id,
              tool_name: toolBlock.name,
              tool_input: parsedInput,
              error: denyReason,
            };
            yield deniedChunk;
            onChunk(deniedChunk);
            continue;
          }
        }

        try {
          const result = await registry.invoke(capabilityName, parsedInput, {
            actor: 'ai',
            origin: toolOrigin,
            session_id: sessionId,
          });

          const resultContent = JSON.stringify(result, null, 2);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: resultContent,
            is_error: !!result.error, // Check for result.error field specifically (not !result.success)
          });

          const resultChunk: AiStreamChunk = {
            type: 'tool_result',
            session_id: sessionId,
            tool_use_id: toolBlock.id,
            tool_name: toolBlock.name,
            tool_input: parsedInput,
            tool_result: result,
          };
          yield resultChunk;
          onChunk(resultChunk);
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolBlock.id,
            content: errorMsg,
            is_error: true,
          });

          const errChunk: AiStreamChunk = {
            type: 'tool_result',
            session_id: sessionId,
            tool_use_id: toolBlock.id,
            tool_name: toolBlock.name,
            error: errorMsg,
          };
          yield errChunk;
          onChunk(errChunk);
        }
      }

      // Add assistant response (with tool calls) to history
      if (assistantContent.length > 0) {
        session.messages.push({
          role: 'assistant',
          content: assistantContent,
        });
      }

      // Add tool results to history
      if (toolResults.length > 0) {
        session.messages.push({
          role: 'user',
          content: toolResults,
        });
      }

      // If no tool calls were made (end_turn), we're done
      if (stopReason === 'end_turn' || (toolResults.length === 0 && currentTextBlock)) {
        const doneChunk: AiStreamChunk = {
          type: 'done',
          session_id: sessionId,
          done: true,
          usage: usage || undefined,
        };
        yield doneChunk;
        onChunk(doneChunk);
        return;
      }

      // If max_tokens reached, auto-continue instead of terminating
      if (stopReason === 'max_tokens') {
        if (continuationCount < MAX_CONTINUATIONS) {
          continuationCount++;
          session.messages.push({ role: 'user', content: '[请继续]' });
          continue; // Continue the while loop for another API call
        }
        // Max continuations exhausted — graceful termination
        const doneChunk: AiStreamChunk = {
          type: 'done',
          session_id: sessionId,
          done: true,
          content: `响应已达到最大长度限制，已自动续接 ${continuationCount} 次。`,
          usage: usage || undefined,
        };
        yield doneChunk;
        onChunk(doneChunk);
        return;
      }

      // Otherwise continue loop (tool_use → more responses)
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const errChunk: AiStreamChunk = {
        type: 'error',
        session_id: sessionId,
        error: errorMsg,
      };
      yield errChunk;
      onChunk(errChunk);

      const doneChunk: AiStreamChunk = {
        type: 'done',
        session_id: sessionId,
        done: true,
        error: errorMsg,
      };
      yield doneChunk;
      onChunk(doneChunk);
      return;
    }
  }

  // Max turns reached
  const doneChunk: AiStreamChunk = {
    type: 'done',
    session_id: sessionId,
    done: true,
    content: `已达到最大对话轮次 (${maxTurns})。`,
  };
  yield doneChunk;
  onChunk(doneChunk);
}

// ── System Prompt Builder ──────────────────────────────────────

function buildSystemPrompt(
  basePrompt: SystemMessageParam[],
  context: ConversationContext
): SystemMessageParam[] {
  const contextBlock = buildContextBlock(context);
  return [...basePrompt, ...contextBlock];
}

function buildContextBlock(context: ConversationContext): SystemMessageParam[] {
  const blocks: SystemMessageParam[] = [];
  const lines: string[] = [];

  lines.push('<evolveflow_context>');
  lines.push(`当前日期: ${context.currentDate}`);
  lines.push(`工作时间: ${context.workHours.start} - ${context.workHours.end}`);
  lines.push(`排程风格: ${context.scheduleStyle}`);
  lines.push(`待处理任务: ${context.totalPending} 个`);
  lines.push(`今日已完成: ${context.completedToday} 个`);

  if (context.overdueTasks.length > 0) {
    lines.push('\n⚠️ 逾期任务:');
    for (const t of context.overdueTasks) {
      lines.push(`  - ${t.title} (截止: ${t.dueDate})`);
    }
  }

  if (context.todayTasks.length > 0) {
    lines.push('\n📋 今日任务:');
    for (const t of context.todayTasks) {
      const status = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⏳';
      lines.push(
        `  ${status} ${t.title}${t.estimatedMinutes ? ` (${t.estimatedMinutes}分钟)` : ''}${t.priority ? ` [优先级${t.priority}]` : ''}${t.project ? ` [${t.project}]` : ''}`
      );
    }
  }

  if (context.todayEvents.length > 0) {
    lines.push('\n📅 今日事件:');
    for (const e of context.todayEvents) {
      lines.push(`  - ${e.title}: ${e.startTime} → ${e.endTime}`);
    }
  }

  if (context.todayBlocks.length > 0) {
    lines.push('\n🗓️ 今日排程:');
    for (const b of context.todayBlocks) {
      lines.push(
        `  - ${b.startTime.slice(11, 16)}-${b.endTime.slice(11, 16)}: ${b.title}${b.isLocked ? ' 🔒' : ''}`
      );
    }
  }

  if (context.dreamInsights.length > 0) {
    lines.push('\n💡 学习洞察:');
    for (const insight of context.dreamInsights) {
      lines.push(`  - ${insight}`);
    }
  }

  if (context.pendingReminders > 0) {
    lines.push(`\n⏰ 待处理提醒: ${context.pendingReminders} 个`);
  }

  lines.push('</evolveflow_context>');
  lines.push(
    '\n请基于以上上下文帮助用户管理日程。如果用户询问需要当前数据的问题，请使用工具查询。主动为用户提供日程优化建议。'
  );

  blocks.push({
    type: 'text',
    text: lines.join('\n'),
    cache_control: { type: 'ephemeral' },
  });

  return blocks;
}

// ── Token Estimation ─────────────────────────────────────────────

/**
 * Estimate token count with CJK-aware character weighting.
 * Heuristic: ASCII chars average ~4 chars/token, CJK chars average ~2 chars/token.
 *
 * CJK ranges covered:
 *   U+4E00-U+9FFF CJK Unified Ideographs
 *   U+3400-U+4DBF CJK Unified Ideographs Extension A
 *   U+F900-U+FAFF CJK Compatibility Ideographs
 *   U+2E80-U+2EFF CJK Radicals Supplement
 *   U+3000-U+303F CJK Symbols and Punctuation
 *   U+FF00-U+FFEF Fullwidth Forms
 *   U+20000-U+2A6DF CJK Supplement
 */
function estimateTokens(messages: MessageParam[], systemPrompt: SystemMessageParam[]): number {
  let total = 0;
  for (const block of systemPrompt) {
    total += weightedCharCount(block.text || '') / ESTIMATED_CHARS_PER_TOKEN;
  }
  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    total += weightedCharCount(content) / ESTIMATED_CHARS_PER_TOKEN;
  }
  return Math.ceil(total);
}

/**
 * Count characters with CJK weighting.
 * CJK characters count as 2 toward the weighted total; ASCII and others count as 1.
 * Dividing the result by ESTIMATED_CHARS_PER_TOKEN (4) yields:
 *   ASCII: ~4 chars/token, CJK: ~2 chars/token.
 */
function weightedCharCount(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.codePointAt(i)!;
    if (code > 0xffff) {
      i++;
    } // skip trailing surrogate
    if (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility
      (code >= 0x2e80 && code <= 0x2eff) || // CJK Radicals
      (code >= 0x3000 && code <= 0x303f) || // CJK Symbols
      (code >= 0xff00 && code <= 0xffef) || // Halfwidth/Fullwidth
      (code >= 0x2f800 && code <= 0x2fa1f) // CJK Compatibility Supplement
    ) {
      count += 2; // CJK ~2 chars per token
    } else {
      count += 1; // ASCII ~4 chars per token
    }
  }
  return count;
}

// ── Compaction ─────────────────────────────────────────────────

function compactConversation(session: AiSessionState): void {
  // Keep system-level context by preserving the first few messages
  // and the most recent messages. Compress the middle.
  if (session.messages.length <= 6) {
    return;
  }

  const KEEP_FIRST = 2; // Keep first user-assistant pair
  const KEEP_LAST = 4; // Keep last few turns

  const firstMessages = session.messages.slice(0, KEEP_FIRST);
  const middleMessages = session.messages.slice(KEEP_FIRST, -KEEP_LAST);
  const lastMessages = session.messages.slice(-KEEP_LAST);

  const compressedCount = middleMessages.length;
  if (compressedCount > 0) {
    const summary = buildCompactSummary(middleMessages, compressedCount);

    const summaryMessage: MessageParam = {
      role: 'user',
      content: summary,
    };

    session.messages = [...firstMessages, summaryMessage, ...lastMessages];

    // Validate message alternation — repair consecutive user messages
    ensureMessageAlternation(session.messages);
  }
}

function shouldEmitToolApproval(
  decision: Promise<ToolPermissionDecision | boolean> | ToolPermissionDecision | boolean,
  mutating: boolean
): boolean {
  if (decision instanceof Promise) {
    return mutating;
  }
  if (typeof decision === 'object' && 'requiresApproval' in decision) {
    return !!decision.requiresApproval;
  }
  return false;
}

async function resolveToolPermission(
  decision: Promise<ToolPermissionDecision | boolean> | ToolPermissionDecision | boolean
): Promise<ToolPermissionDecision> {
  const resolved = await decision;
  if (typeof resolved === 'boolean') {
    return { allow: resolved };
  }
  return resolved;
}

/**
 * Build a meaningful summary from compressed messages.
 * Scans for task IDs, decisions, and preference changes.
 */
function buildCompactSummary(messages: MessageParam[], count: number): string {
  const taskIds = new Set<string>();
  const decisions: string[] = [];
  const prefChanges: string[] = [];

  // Match patterns like "task-xxx", "task_xxx", "任务xxx"
  const taskIdRe = /(?:task|任务)[\s\-_:：#]*([a-zA-Z0-9\-_]+)/gi;

  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);

    // Extract task IDs
    let m: RegExpExecArray | null;
    while ((m = taskIdRe.exec(content)) !== null) {
      if (m[1] && m[1].length > 0 && !m[1].startsWith('-')) {
        taskIds.add(m[1]);
      }
    }

    // Detect decision-like and preference-related sentences
    const sentences = content.split(/[。！？\n.!?\n]+/);
    for (const sentence of sentences) {
      const s = sentence.trim();
      if (!s || s.length < 4) {
        continue;
      }

      // Decision keywords (Chinese and English)
      if (
        /^(?:决定|确认|同意|已安排|已|create |update |delete |schedule|reschedule|cancel |confirm |approve |reject )/i.test(
          s
        )
      ) {
        if (s.length > 5 && s.length < 120 && !decisions.includes(s)) {
          decisions.push(s);
        }
      }

      // Preference changes
      if (/(?:喜欢|偏好|优先|prefer|改成|改为|change.*to|调整.*为)/i.test(s)) {
        if (s.length > 3 && s.length < 80 && !prefChanges.includes(s)) {
          prefChanges.push(s);
        }
      }
    }
  }

  const parts: string[] = [`[对话压缩: ${count}条消息已合并`];

  if (taskIds.size > 0) {
    const ids = Array.from(taskIds);
    parts.push(
      `涉及任务: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? `等${ids.length}个` : ''}`
    );
  }

  if (decisions.length > 0) {
    parts.push(`关键决策: ${decisions.slice(0, 3).join('; ')}`);
  }

  if (prefChanges.length > 0) {
    parts.push(`偏好调整: ${prefChanges.slice(0, 2).join('; ')}`);
  }

  if (parts.length === 1) {
    // No specific info extracted — use a generic but informative fallback
    return `[对话压缩: ${count}条消息已合并。中间对话已压缩以节省上下文空间。]`;
  }

  return parts.join('。') + '。]';
}

/**
 * Validate message alternation and repair consecutive user messages.
 * When two user messages appear in a row (possible after compaction),
 * merge them or insert an assistant placeholder.
 */
function ensureMessageAlternation(messages: MessageParam[]): void {
  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === 'user' && messages[i - 1].role === 'user') {
      // Insert an assistant placeholder to maintain proper user/assistant alternation
      messages.splice(i, 0, { role: 'assistant', content: '[已压缩]' });
      i++; // Skip past the newly inserted placeholder
    }
  }
}

/**
 * Aggressively compact when token budget is still exceeded after normal compaction.
 * Keeps only 2 first + 2 last messages with a terse summary.
 */
function aggressiveCompact(session: AiSessionState): void {
  // Guard: don't compact if there are too few messages — it would duplicate content.
  if (session.messages.length <= 4) {
    return;
  }

  const KEEP_FIRST = 2;
  const KEEP_LAST = 2;

  const firstMessages = session.messages.slice(0, KEEP_FIRST);
  const middleMessages = session.messages.slice(KEEP_FIRST, -KEEP_LAST);
  const lastMessages = session.messages.slice(-KEEP_LAST);

  const compressedCount = middleMessages.length;
  const summary = buildCompactSummary(middleMessages, compressedCount);

  // Remove the outer brackets from summary so we can wrap it in an "紧急压缩" tag
  const stripped = summary
    .replace(/^\[对话压缩:/, '')
    .replace(/\]$/, '')
    .trim();
  const aggressiveSummary: MessageParam = {
    role: 'user',
    content: `[紧急压缩: ${compressedCount}条消息已合并。${stripped}]`,
  };

  session.messages = [...firstMessages, aggressiveSummary, ...lastMessages];
  ensureMessageAlternation(session.messages);
}

// ── Export ─────────────────────────────────────────────────────

export { DEFAULT_MAX_TURNS, DEFAULT_TOKEN_BUDGET, DEFAULT_COMPACT_AT };
