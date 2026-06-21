/**
 * 真实 DeepSeek e2e 集成测试（非 mock）。
 *
 * 这是 pi 迁移的生死线：pi-engine.ts 当年就是这里翻车（响应空）。
 * 用 harness-manager 经真实 API 发一条消息，断言：
 *   1. 不抛错
 *   2. 返回非空 assistant 文本
 *   3. 能力工具能被调用（task.list 返回真实结果）
 *
 * 运行：DEEPSEEK_API_KEY=... npx vitest run tests/harness-e2e-real.test.ts
 * 无 key 时跳过（不影响 CI）。
 */
import { describe, it, expect } from 'vitest';
import { createInMemoryHarnessManager } from '../src/ai/harness-manager.js';
import type {
  CapabilityRegistry,
  CapabilityDefinition,
  CapabilityContext,
} from '@evolveflow/capabilities';

const KEY = process.env.DEEPSEEK_API_KEY;

function mockRegistry(): CapabilityRegistry {
  const caps: CapabilityDefinition[] = [
    {
      name: 'task.list',
      domain: 'task',
      description: '列出当前所有任务。当用户问"我的任务"或想看待办时调用。',
      inputSchema: { type: 'object', properties: {}, required: [] },
      mutating: false,
      handler: async () => ({
        success: true,
        data: [{ id: 't1', title: '写周报', status: 'pending' }],
      }),
    },
  ];
  const map = new Map(caps.map((c) => [c.name, c]));
  return {
    list: () => Array.from(map.values()),
    get: (n: string) => map.get(n),
    has: (n: string) => map.has(n),
    register: () => {},
    listByDomain: () => [],
    getMutatingCapabilities: () => [],
    onAfterInvoke: () => {},
    invoke: async (n: string) => {
      const c = map.get(n);
      return c
        ? c.handler({}, { actor: 'ai', origin: 'test' })
        : { success: false, error: 'not found' };
    },
  } as unknown as CapabilityRegistry;
}

describe.skipIf(!KEY)('harness-manager 真实 DeepSeek e2e', () => {
  it('返回非空 assistant 文本', async () => {
    const chunks: Array<{ type: string; content?: string }> = [];
    const manager = createInMemoryHarnessManager({
      db: {
        getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) as never }),
      } as never,
      registry: mockRegistry(),
      apiKey: KEY!,
      onChunk: (c) => chunks.push({ type: c.type, content: c.content }),
    });
    const capCtx: CapabilityContext = { actor: 'ai', origin: 'test', session_id: 'e2e-1' };
    let threw: unknown;
    let text = '';
    try {
      text = await manager.prompt('e2e-1', 'yolo', '请用一句话自我介绍。', capCtx);
    } catch (e) {
      threw = e;
      console.log('=== PROMPT THREW ===', e);
    }
    console.log('=== assistant text ===\n' + JSON.stringify(text) + '\n=== end ===');
    console.log('=== all chunks ===\n' + JSON.stringify(chunks, null, 0));
    if (threw) {
      throw threw;
    }
    expect((text ?? '').length).toBeGreaterThan(5);
  }, 90000);

  it('能调用能力工具（task.list）', async () => {
    const chunks: Array<{ type: string; tool_name?: string }> = [];
    const manager = createInMemoryHarnessManager({
      db: {
        getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) as never }),
      } as never,
      registry: mockRegistry(),
      apiKey: KEY!,
      onChunk: (c) =>
        chunks.push({ type: c.type, tool_name: (c as { tool_name?: string }).tool_name }),
    });
    const capCtx: CapabilityContext = { actor: 'ai', origin: 'test', session_id: 'e2e-2' };
    const text = await manager.prompt('e2e-2', 'yolo', '列出我的任务。', capCtx);
    console.log('=== text ===\n' + text + '\n=== chunks ===\n' + JSON.stringify(chunks, null, 0));
    // 应该至少出现一次 tool_use_start（task.list）
    expect(chunks.some((c) => c.type === 'tool_use_start' && c.tool_name === 'task.list')).toBe(
      true
    );
    // assistant 最终文本非空
    expect(text.length).toBeGreaterThan(0);
  }, 90000);
});
