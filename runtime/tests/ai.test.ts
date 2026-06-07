import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiClient } from '../src/ai/client.js';
import { buildConversationContext } from '../src/ai/context.js';
import { capabilityToToolName, toolToCapabilityName } from '../src/ai/tools.js';
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
    text: async () => JSON.stringify({
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

  it('removes Anthropic cache control blocks for DeepSeek-compatible requests', async () => {
    const fetchMock = vi.fn(async () => mockMessageResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = new ApiClient({
      apiKey: 'test-key',
      baseUrl: 'https://api.deepseek.com/anthropic',
      model: 'deepseek-v4-pro[1m]',
      provider: 'deepseek',
      maxRetries: 0,
    });

    await client.createMessage(
      [{ role: 'user', content: 'hello' }],
      undefined,
      [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    expect(body.system[0]).toEqual({ type: 'text', text: 'system prompt' });
  });

  it('preserves Anthropic beta headers and cache control for Anthropic requests', async () => {
    const fetchMock = vi.fn(async () => mockMessageResponse());
    vi.stubGlobal('fetch', fetchMock);

    const client = new ApiClient({
      apiKey: 'test-key',
      model: 'claude-sonnet-4-20250514',
      provider: 'anthropic',
      maxRetries: 0,
    });

    await client.createMessage(
      [{ role: 'user', content: 'hello' }],
      undefined,
      [{ type: 'text', text: 'system prompt', cache_control: { type: 'ephemeral' } }],
    );

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(init.body));
    const headers = init.headers as Record<string, string>;
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(headers['anthropic-version']).toBe('2023-06-01');
  });
});

describe('AI tool and context adapters', () => {
  it('round-trips capability names with underscores', () => {
    expect(toolToCapabilityName(capabilityToToolName('task.create'))).toBe('task.create');
    expect(toolToCapabilityName(capabilityToToolName('schedule.plan_day'))).toBe('schedule.plan_day');
    expect(toolToCapabilityName(capabilityToToolName('memory.clear_ai_history'))).toBe('memory.clear_ai_history');
  });

  it('loads current-schema tasks and schedule blocks into conversation context', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-runtime-test-'));
    const db = new EvolveFlowDatabase(path.join(tmpDir, 'test.db'));
    try {
      const database = db.getDb();
      const today = new Date().toISOString().split('T')[0];
      const now = new Date().toISOString();

      database
        .prepare(
          `INSERT INTO tasks
            (id, title, duration_minutes, due_date, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`,
        )
        .run('task-1', 'Focus work', 60, today, now, now);
      database
        .prepare(
          `INSERT INTO events
            (id, title, start_time, end_time, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run('event-1', 'Design review', `${today}T11:00:00`, `${today}T12:00:00`, now, now);
      database
        .prepare(
          `INSERT INTO schedule_blocks
            (id, task_id, event_id, date, start_time, end_time, locked, manual_signal, created_at, updated_at)
           VALUES (?, ?, NULL, ?, ?, ?, 1, 0, ?, ?)`,
        )
        .run('block-task', 'task-1', today, `${today}T09:00:00`, `${today}T10:00:00`, now, now);
      database
        .prepare(
          `INSERT INTO schedule_blocks
            (id, task_id, event_id, date, start_time, end_time, locked, manual_signal, created_at, updated_at)
           VALUES (?, NULL, ?, ?, ?, ?, 0, 0, ?, ?)`,
        )
        .run('block-event', 'event-1', today, `${today}T11:00:00`, `${today}T12:00:00`, now, now);

      const context = await buildConversationContext(
        db,
        undefined as unknown as CapabilityRegistry,
        { maxTodayTasks: 5, maxTodayBlocks: 5 },
      );

      expect(context.todayTasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'task-1', title: 'Focus work', estimatedMinutes: 60 }),
        ]),
      );
      expect(context.todayBlocks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 'block-task', title: 'Focus work', isLocked: true }),
          expect.objectContaining({ id: 'block-event', title: 'Design review', isLocked: false }),
        ]),
      );
    } finally {
      db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
