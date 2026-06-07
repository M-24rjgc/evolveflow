/**
 * Complete Anthropic Messages API type definitions.
 * Hand-written, zero SDK dependency. Based on Anthropic API docs.
 * @see https://docs.anthropic.com/en/api/messages
 */

// ── Message Types ──────────────────────────────────────────────

export interface TextBlock {
  type: 'text';
  text: string;
}

export interface ToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature: string;
}

export interface ToolResultImageBlock {
  type: 'image';
  source: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string | Array<TextBlock | ToolResultImageBlock>;
  is_error?: boolean;
}

export type ContentBlock = TextBlock | ToolUseBlock | ThinkingBlock | ToolResultBlock;
export type AssistantContentBlock = TextBlock | ToolUseBlock | ThinkingBlock;

export interface MessageParam {
  role: 'user' | 'assistant';
  content: string | ContentBlock[];
}

export interface SystemMessageParam {
  type?: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

// ── Tool Definition ────────────────────────────────────────────

export interface AnthropicTool {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

// ── API Request / Response ─────────────────────────────────────

export interface CreateMessageParams {
  model: string;
  max_tokens: number;
  system?: string | SystemMessageParam[];
  messages: MessageParam[];
  tools?: AnthropicTool[];
  tool_choice?: { type: 'auto' } | { type: 'any' } | { type: 'tool'; name: string };
  stop_sequences?: string[];
  temperature?: number;
  metadata?: { user_id?: string };
  thinking?: { type: 'enabled'; budget_tokens?: number } | { type: 'disabled' };
  stream?: boolean;
}

export type StopReason = 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';

export interface UsageInfo {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface CreateMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  model: string;
  content: AssistantContentBlock[];
  stop_reason: StopReason | null;
  stop_sequence: string | null;
  usage: UsageInfo;
}

// ── Streaming Types ────────────────────────────────────────────

export type StreamEventType =
  | 'message_start'
  | 'content_block_start'
  | 'content_block_delta'
  | 'content_block_stop'
  | 'message_delta'
  | 'message_stop'
  | 'ping'
  | 'error';

export interface MessageStartEvent {
  type: 'message_start';
  message: {
    id: string;
    type: 'message';
    role: 'assistant';
    model: string;
    usage: UsageInfo | null;
  };
}

export interface ContentBlockStartEvent {
  type: 'content_block_start';
  index: number;
  content_block:
    | {
        type: 'text';
        text: '';
      }
    | {
        type: 'tool_use';
        id: string;
        name: string;
        input: Record<string, unknown>;
      }
    | {
        type: 'thinking';
        thinking: string;
        signature: string;
      };
}

export interface TextDelta {
  type: 'text_delta';
  text: string;
}

export interface InputJsonDelta {
  type: 'input_json_delta';
  partial_json: string;
}

export interface ThinkingDelta {
  type: 'thinking_delta';
  thinking: string;
}

export interface SignatureDelta {
  type: 'signature_delta';
  signature: string;
}

export type ContentDelta = TextDelta | InputJsonDelta | ThinkingDelta | SignatureDelta;

export interface ContentBlockDeltaEvent {
  type: 'content_block_delta';
  index: number;
  delta: ContentDelta;
}

export interface ContentBlockStopEvent {
  type: 'content_block_stop';
  index: number;
}

export interface MessageDeltaEvent {
  type: 'message_delta';
  delta: {
    stop_reason: StopReason | null;
    stop_sequence: string | null;
  };
  usage: { output_tokens: number };
}

export interface MessageStopEvent {
  type: 'message_stop';
}

export type StreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | { type: 'ping' }
  | { type: 'error'; error: { type: string; message: string } };

// ── AI Session Types ───────────────────────────────────────────

export interface AiSessionState {
  sessionId: string;
  messages: MessageParam[];
  createdAt: number;
  lastActivityAt: number;
  totalTokens: UsageInfo;
  model: string;
}

export interface AiStreamChunk {
  type:
    | 'text_delta'
    | 'tool_use_start'
    | 'tool_use_delta'
    | 'tool_result'
    | 'tool_permission_request'
    | 'thinking_delta'
    | 'session_start'
    | 'done'
    | 'error';
  session_id: string;
  content?: string;
  approval_id?: string;
  capability_name?: string;
  mutating?: boolean;
  tool_name?: string;
  tool_use_id?: string;
  tool_input?: Record<string, unknown>;
  tool_result?: unknown;
  error?: string;
  usage?: UsageInfo;
  done?: boolean;
}

export interface ConversationContext {
  currentDate: string;
  todayTasks: Array<{
    id: string;
    title: string;
    status: string;
    dueDate?: string;
    priority?: number;
    estimatedMinutes?: number;
    project?: string;
  }>;
  todayEvents: Array<{
    id: string;
    title: string;
    startTime: string;
    endTime: string;
  }>;
  todayBlocks: Array<{
    id: string;
    taskId?: string;
    title: string;
    startTime: string;
    endTime: string;
    isLocked: boolean;
  }>;
  overdueTasks: Array<{
    id: string;
    title: string;
    dueDate: string | undefined;
  }>;
  workHours: { start: string; end: string };
  scheduleStyle: string;
  preferences: Record<string, string>;
  dreamInsights: string[];
  pendingReminders: number;
  completedToday: number;
  totalPending: number;
  truncationNotes?: string[];
}

/**
 * Validate that messages follow Anthropic API alternation rules:
 * - Must start with role "user"
 * - Roles must alternate between "user" and "assistant"
 */
export function validateMessageAlternation(messages: MessageParam[]): {
  valid: boolean;
  error?: string;
} {
  if (messages.length === 0) {
    return { valid: true };
  }

  if (messages[0].role !== 'user') {
    return { valid: false, error: 'First message must have role "user"' };
  }

  for (let i = 1; i < messages.length; i++) {
    if (messages[i].role === messages[i - 1].role) {
      return {
        valid: false,
        error: `Messages must alternate between "user" and "assistant". Found consecutive "${messages[i].role}" roles at index ${i - 1} and ${i}`,
      };
    }
  }

  return { valid: true };
}
