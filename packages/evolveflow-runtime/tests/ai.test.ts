import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/ai/client.js';
import { DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_MODEL } from '../src/ai/deepseek.js';
import { buildConversationContext } from '../src/ai/context.js';
import {
  capabilitiesToTools,
  capabilityToToolName,
  getToolListingPrompt,
  toolToCapabilityName,
} from '../src/ai/tools.js';
import { runConversation } from '../src/ai/loop.js';
import { compactConversation, splitForCompaction } from '../src/ai/loop.js';
import type { AiSessionState, MessageParam } from '../src/ai/types.js';
import { EvolveFlowDatabase } from '@evolveflow/storage';
import type { CapabilityRegistry } from '@evolveflow/capabilities';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

function mockMessageResponse() {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    text: async () =>
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'OK' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }),
  } as Response;
}

describe('ApiClient', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('always sends DeepSeek-V4-Flash to the official DeepSeek endpoint', async () => {
    const fetchMock = vi.fn(async () => mockMessageResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = new ApiClient({
      apiKey: 'test-key',
      baseUrl: 'https://example.invalid/anthropic',
      model: 'deepseek-v4-pro[1m]',
      provider: 'deepseek',
      maxRetries: 0,
    });

    await client.createMessage([{ role: 'user', content: 'hello' }], undefined, [
      { type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } },
    ]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const url = String(fetchMock.mock.calls[0][0]);
    const body = JSON.parse(String(init.body));
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(`${DEEPSEEK_ANTHROPIC_BASE_URL}/v1/messages`);
    expect(body.model).toBe(DEEPSEEK_MODEL);
    expect(body.system[0]).toEqual({ type: 'text', text: 'system prompt' });
    expect(headers['x-api-key']).toBe('test-key');
    expect(headers['anthropic-version']).toBeUndefined();
  });

  it('ignores deprecated Anthropic model and provider overrides', async () => {
    const fetchMock = vi.fn(async () => mockMessageResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = new ApiClient({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      maxRetries: 0,
    });

    await client.createMessage([{ role: 'user', content: 'hello' }], undefined, [
      { type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } },
    ]);

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const url = String(fetchMock.mock.calls[0][0]);
    const body = JSON.parse(String(init.body));
    expect(url).toBe(`${DEEPSEEK_ANTHROPIC_BASE_URL}/v1/messages`);
    expect(body.model).toBe(DEEPSEEK_MODEL);
    expect(client.getProvider()).toBe('deepseek');
    expect(client.getModel()).toBe(DEEPSEEK_MODEL);
    expect(client.getBaseUrl()).toBe(DEEPSEEK_ANTHROPIC_BASE_URL);
  });

  it('retries a timeout (AbortError) the configured number of times, not half', async () => {
    // Regression: the AbortError branch used to increment attempt a second
    // time (on top of the loop header), so each timeout consumed two retry
    // slots. With maxRetries=2 we must see exactly 3 fetch calls (1 initial
    // + 2 retries), not 2.
    vi.useFakeTimers();
    const abortErr = new DOMException('The user aborted a request', 'AbortError');
    const fetchMock = vi.fn(async () => {
      throw abortErr;
    });
    vi.stubGlobal('fetch', fetchMock);

    const client = new ApiClient({ apiKey: 'test-key', maxRetries: 2 });

    let rejection: unknown;
    const consumer = (async () => {
      for await (const _chunk of client.streamMessage([{ role: 'user', content: 'hi' }])) {
        void _chunk;
      }
    })().catch((e) => {
      rejection = e;
    });

    // Drive the retry backoff sleeps and the per-request timeout timers to
    // completion without waiting in real time. The consumer catches its own
    // rejection so it never becomes an unhandled rejection while timers run.
    for (let i = 0; i < 30 && !rejection; i++) {
      await vi.advanceTimersByTimeAsync(2000);
    }
    await consumer;

    // 1 initial attempt + 2 retries == 3 total fetch calls.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });
});

describe('AI tool and context adapters', () => {
  it('round-trips capability names with underscores', () => {
    expect(toolToCapabilityName(capabilityToToolName('task.create'))).toBe('task.create');
    expect(toolToCapabilityName(capabilityToToolName('schedule.plan_day'))).toBe(
      'schedule.plan_day'
    );
    expect(toolToCapabilityName(capabilityToToolName('memory.clear_ai_history'))).toBe(
      'memory.clear_ai_history'
    );
  });

  it('emits DeepSeek-compatible closed object schemas for tools', () => {
    const registry = {
      list: () => [
        {
          name: 'task.create',
          domain: 'task',
          description: 'Create task',
          mutating: true,
          inputSchema: {
            type: 'object',
            properties: {
              title: { type: 'string', default: 'Untitled' },
              priority: { type: 'number' },
            },
            required: ['title', 'missing_field'],
          },
        },
      ],
    } as unknown as CapabilityRegistry;

    const [tool] = capabilitiesToTools(registry);
    expect(tool.input_schema).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        priority: { type: 'number' },
      },
      required: ['title'],
      additionalProperties: false,
    });
  });

  it('can filter tool listings to match mode-specific tool exposure', () => {
    const registry = {
      list: () => [
        {
          name: 'task.create',
          domain: 'task',
          description: 'Create task',
          mutating: true,
          inputSchema: { type: 'object', properties: {} },
        },
        {
          name: 'task.list',
          domain: 'task',
          description: 'List tasks',
          mutating: false,
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    } as unknown as CapabilityRegistry;

    const prompt = getToolListingPrompt(registry, {
      include: (capability) => !capability.mutating,
    });
    expect(prompt).toContain('task_list');
    expect(prompt).not.toContain('task_create');
  });

  it('loads current-schema tasks and schedule blocks into conversation context', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-runtime-test-'));
    const db = new EvolveFlowDatabase(path.join(tmpDir, 'test.db'));
    try {
      const database = db.getDb();
      const localNow = new Date();
      const today = [
        localNow.getFullYear(),
        String(localNow.getMonth() + 1).padStart(2, '0'),
        String(localNow.getDate()).padStart(2, '0'),
      ].join('-');
      const now = new Date().toISOString();

      database
        .prepare(
          `INSERT INTO tasks
            (id, title, duration_minutes, due_date, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run('task-1', 'Focus work', 60, today, now, now);
      database
        .prepare(
          `INSERT INTO events
            (id, title, start_time, end_time, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('event-1', 'Design review', `${today}T11:00:00`, `${today}T12:00:00`, now, now);
      database
        .prepare(
          `INSERT INTO schedule_blocks
            (id, task_id, event_id, date, start_time, end_time, locked, manual_signal, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, 1, 0, ?, ?)`
        )
        .run('block-task', 'task-1', today, `${today}T09:00:00`, `${today}T10:00:00`, now, now);
      database
        .prepare(
          `INSERT INTO schedule_blocks
            (id, task_id, event_id, date, start_time, end_time, locked, manual_signal, created_at, updated_at)
           VALUES (?, NULL, ?, ?, ?, ?, 0, 0, ?, ?)`
        )
        .run('block-event', 'event-1', today, `${today}T11:00:00`, `${today}T12:00:00`, now, now);

      const context = await buildConversationContext(
        db,
        undefined as unknown as CapabilityRegistry,
        { maxTodayTasks: 5, maxTodayBlocks: 5 }
      );

      expect(context.todayTasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'task-1', title: 'Focus work', estimatedMinutes: 60 }),
        ])
      );
      expect(context.todayBlocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'block-task', title: 'Focus work', isLocked: true }),
          expect.objectContaining({ id: 'block-event', title: 'Design review', isLocked: false }),
        ])
      );
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('AI prompt modes', () => {
  const context = {
    currentDate: '2026-06-08T10:00:00',
    todayTasks: [],
    todayEvents: [],
    todayBlocks: [],
    overdueTasks: [],
    workHours: { start: '09:00', end: '18:00' },
    scheduleStyle: 'balanced',
    preferences: {},
    dreamInsights: [],
    pendingReminders: 0,
    completedToday: 0,
    totalPending: 0,
  };

  function createPromptCaptureClient(capture: (systemPrompt: unknown) => void) {
    return {
      getModel: () => DEEPSEEK_MODEL,
      getThinkingConfig: () => ({ type: 'disabled' as const }),
      async *streamMessage(_messages: unknown, _tools: unknown, systemPrompt: unknown) {
        capture(systemPrompt);
        yield {
          type: 'message_start' as const,
          message: {
            id: 'msg',
            type: 'message' as const,
            role: 'assistant' as const,
            model: DEEPSEEK_MODEL,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: 'content_block_start' as const,
          index: 0,
          content_block: { type: 'text' as const, text: '' },
        };
        yield {
          type: 'content_block_delta' as const,
          index: 0,
          delta: { type: 'text_delta' as const, text: 'OK' },
        };
        yield { type: 'content_block_stop' as const, index: 0 };
        yield {
          type: 'message_delta' as const,
          delta: { stop_reason: 'end_turn' as const, stop_sequence: null },
          usage: { output_tokens: 1 },
        };
        yield { type: 'message_stop' as const };
      },
    } as unknown as ApiClient;
  }

  function systemPromptToText(systemPrompt: unknown): string {
    return (systemPrompt as Array<{ text: string }>).map((block) => block.text).join('\n');
  }

  it('keeps chat mode out of tool-agent instructions', async () => {
    let capturedSystemPrompt: unknown;

    for await (const _chunk of runConversation('hello', {
      client: createPromptCaptureClient((systemPrompt) => {
        capturedSystemPrompt = systemPrompt;
      }),
      registry: { list: () => [] } as unknown as CapabilityRegistry,
      tools: [],
      systemPrompt: [],
      context,
      mode: 'chat',
      sessionId: 'prompt-chat',
      onChunk: () => {},
    })) {
      // Drain generator.
    }

    const systemText = systemPromptToText(capturedSystemPrompt);
    expect(systemText).toContain('这是一个只读上下文快照');
    expect(systemText).toContain('你不能调用工具');
    expect(systemText).not.toContain('请使用工具查询');
    expect(systemText).not.toContain('主动为用户提供日程优化建议');
  });

  it('keeps auto mode agent-oriented context instructions', async () => {
    let capturedSystemPrompt: unknown;

    for await (const _chunk of runConversation('help me plan', {
      client: createPromptCaptureClient((systemPrompt) => {
        capturedSystemPrompt = systemPrompt;
      }),
      registry: { list: () => [] } as unknown as CapabilityRegistry,
      tools: [],
      systemPrompt: [],
      context,
      mode: 'auto',
      sessionId: 'prompt-auto',
      onChunk: () => {},
    })) {
      // Drain generator.
    }

    const systemText = systemPromptToText(capturedSystemPrompt);
    expect(systemText).toContain('请基于以上上下文帮助用户管理日程');
    expect(systemText).toContain('请使用工具查询');
  });
});

describe('AI tool permission loop', () => {
  const context = {
    currentDate: '2026-06-08T10:00:00',
    todayTasks: [],
    todayEvents: [],
    todayBlocks: [],
    overdueTasks: [],
    workHours: { start: '09:00', end: '18:00' },
    scheduleStyle: 'balanced',
    preferences: {},
    dreamInsights: [],
    pendingReminders: 0,
    completedToday: 0,
    totalPending: 0,
  };

  function createToolClient() {
    return {
      getModel: () => DEEPSEEK_MODEL,
      getThinkingConfig: () => ({ type: 'enabled' as const }),
      async *streamMessage() {
        yield {
          type: 'message_start' as const,
          message: {
            id: 'msg',
            type: 'message' as const,
            role: 'assistant' as const,
            model: DEEPSEEK_MODEL,
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        };
        yield {
          type: 'content_block_start' as const,
          index: 0,
          content_block: {
            type: 'tool_use' as const,
            id: 'toolu_1',
            name: 'task_create',
            input: {},
          },
        };
        yield {
          type: 'content_block_delta' as const,
          index: 0,
          delta: { type: 'input_json_delta' as const, partial_json: '{"title":"Denied task"}' },
        };
        yield {
          type: 'message_delta' as const,
          delta: { stop_reason: 'tool_use' as const, stop_sequence: null },
          usage: { output_tokens: 1 },
        };
        yield { type: 'message_stop' as const };
      },
    } as unknown as ApiClient;
  }

  function createRegistryMock() {
    return {
      list: () => [
        {
          name: 'task.create',
          domain: 'task',
          description: 'Create task',
          mutating: true,
          inputSchema: {
            type: 'object',
            properties: { title: { type: 'string' } },
            required: ['title'],
          },
        },
      ],
      invoke: vi.fn(async () => ({ success: true, data: { id: 'task-1' } })),
    } as unknown as CapabilityRegistry & { invoke: ReturnType<typeof vi.fn> };
  }

  it('emits approval requests and skips denied mutating tools', async () => {
    const registry = createRegistryMock();
    const chunks: Array<{ type: string; approval_id?: string; error?: string }> = [];

    for await (const _chunk of runConversation('create task', {
      client: createToolClient(),
      registry,
      tools: [],
      systemPrompt: [],
      context,
      sessionId: 'perm-deny',
      maxTurns: 1,
      confirmToolUse: () => ({ allow: false, reason: 'denied by test', requiresApproval: true }),
      onChunk: (chunk) => chunks.push(chunk),
    })) {
      // chunks are captured through onChunk
    }

    expect(
      chunks.some((chunk) => chunk.type === 'tool_permission_request' && chunk.approval_id)
    ).toBe(true);
    expect(
      chunks.some((chunk) => chunk.type === 'tool_result' && chunk.error === 'denied by test')
    ).toBe(true);
    expect(registry.invoke).not.toHaveBeenCalled();
  });

  it('emits approval request before awaiting an async tool decision', async () => {
    const registry = createRegistryMock();
    const chunks: Array<{ type: string; approval_id?: string }> = [];
    let resolveDecision: ((decision: { allow: boolean; reason?: string }) => void) | undefined;
    const pendingDecision = new Promise<{ allow: boolean; reason?: string }>((resolve) => {
      resolveDecision = resolve;
    });

    const generator = runConversation('create task', {
      client: createToolClient(),
      registry,
      tools: [],
      systemPrompt: [],
      context,
      sessionId: 'perm-async',
      maxTurns: 1,
      confirmToolUse: () => pendingDecision,
      onChunk: (chunk) => chunks.push(chunk),
    });

    let sawApproval = false;
    for (let i = 0; i < 10; i++) {
      const next = await Promise.race([
        generator.next(),
        new Promise<{ timeout: true }>((resolve) =>
          setTimeout(() => resolve({ timeout: true }), 20)
        ),
      ]);
      if ('timeout' in next) {
        break;
      }
      sawApproval =
        next.value?.type === 'tool_permission_request' ||
        chunks.some((chunk) => chunk.type === 'tool_permission_request');
      if (sawApproval) {
        break;
      }
    }

    expect(sawApproval).toBe(true);
    expect(registry.invoke).not.toHaveBeenCalled();

    resolveDecision?.({ allow: false, reason: 'denied after prompt' });
    for await (const _chunk of generator) {
      // Drain generator after resolving the pending permission.
    }
  });

  it('executes approved mutating tools', async () => {
    const registry = createRegistryMock();

    for await (const _chunk of runConversation('create task', {
      client: createToolClient(),
      registry,
      tools: [],
      systemPrompt: [],
      context,
      sessionId: 'perm-allow',
      maxTurns: 1,
      confirmToolUse: () => true,
      onChunk: () => {},
    })) {
      // Drain generator.
    }

    expect(registry.invoke).toHaveBeenCalledWith(
      'task.create',
      { title: 'Denied task' },
      expect.objectContaining({
        actor: 'ai',
        origin: 'ai_page',
        session_id: 'perm-allow',
        idempotency_key: 'ai:perm-allow:toolu_1',
      })
    );
  });
});

describe('conversation compaction — tool_use/tool_result pairing', () => {
  // Helper: build an alternating user/assistant history where a tool_use in
  // message N is answered by a tool_result in message N+1, straddling the
  // would-be compaction split boundary.
  function buildHistoryWithStraddlingToolCall(): MessageParam[] {
    return [
      { role: 'user', content: '请帮我创建任务' },
      { role: 'assistant', content: '好的' },
      { role: 'user', content: '继续安排今天' },
      // assistant tool_use — its tool_result is in the NEXT user message.
      {
        role: 'assistant',
        content: [
          { type: 'text', text: '我来创建一个任务' },
          { type: 'tool_use', id: 'tool_1', name: 'task_create', input: { title: 'X' } },
        ],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool_1', content: 'created' }],
      },
      { role: 'assistant', content: '已完成' },
      { role: 'user', content: '再帮我看看' },
      { role: 'assistant', content: '没问题' },
      { role: 'user', content: '最后一步' },
      { role: 'assistant', content: '结束' },
    ];
  }

  function makeSession(messages: MessageParam[]): AiSessionState {
    return {
      sessionId: 'compact-test',
      messages,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      totalTokens: { input_tokens: 0, output_tokens: 0 },
      model: 'test',
    };
  }

  /**
   * Assert that every tool_use block in the sequence has its matching
   * tool_result in the immediately following message, per Anthropic API rules.
   */
  function assertToolPairingValid(messages: MessageParam[]): void {
    for (let i = 0; i < messages.length; i++) {
      const useIds = new Set<string>();
      if (Array.isArray(messages[i].content)) {
        for (const block of messages[i].content) {
          if (block.type === 'tool_use') {
            useIds.add(block.id);
          }
        }
      }
      if (useIds.size === 0) {
        continue;
      }
      const next = messages[i + 1];
      const resultIds = new Set<string>();
      if (next && Array.isArray(next.content)) {
        for (const block of next.content) {
          if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
            resultIds.add(block.tool_use_id);
          }
        }
      }
      for (const id of useIds) {
        if (!resultIds.has(id)) {
          throw new Error(
            `tool_use "${id}" at index ${i} has no matching tool_result in the next message`
          );
        }
      }
    }
  }

  it('splitForCompaction keeps a straddling tool_use together with its tool_result', () => {
    const messages = buildHistoryWithStraddlingToolCall();
    // keepFirst=2 would cut right before the tool_use assistant message.
    const { first, middle, last } = splitForCompaction(messages, 2, 4);
    void middle;
    // The head must NOT end with a tool_use whose result is in the tail.
    // Re-unit first+last (what survives compaction) and check pairing.
    assertToolPairingValid([...first, ...last]);
  });

  it('compactConversation produces a history that keeps every tool_use answered', () => {
    const session = makeSession(buildHistoryWithStraddlingToolCall());
    compactConversation(session);
    // After compaction there should be a summary inserted, but no dangling tool_use.
    assertToolPairingValid(session.messages);
  });
});
