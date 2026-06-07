import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/ai/client.js';
import { DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_MODEL } from '../src/ai/deepseek.js';
import { buildConversationContext } from '../src/ai/context.js';
import {
  capabilitiesToTools,
  capabilityToToolName,
  toolToCapabilityName,
} from '../src/ai/tools.js';
import { runConversation } from '../src/ai/loop.js';
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
      expect.objectContaining({ actor: 'ai', origin: 'ai_page', session_id: 'perm-allow' })
    );
  });
});
