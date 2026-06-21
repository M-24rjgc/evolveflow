/**
 * harness-manager + system-prompt + event-mapper 单元测试。
 *
 * 全部无 IO / 无网络 / 无真实 LLM。验证：
 * - manager 能创建 harness（in-memory session）
 * - pi-bridge 的 capability 工具被正确注册进 harness
 * - system-prompt 按 mode 生成且含 <evolveflow_context>
 * - mode 过滤：chat 无工具、plan 只读、auto/yolo 全部
 * - event-mapper 把 pi 事件映射成 AiStreamChunk
 */

import { describe, it, expect } from 'vitest';
import { filterToolsByMode, buildEvolveFlowSystemPrompt } from '../src/ai/system-prompt.js';
import { mapAgentEventToStreamChunk } from '../src/ai/event-mapper.js';
import { createInMemoryHarnessManager } from '../src/ai/harness-manager.js';
import type { AgentTool, AgentHarnessEvent } from '@evolveflow/vendor-pi-agent';
import type {
  CapabilityRegistry,
  CapabilityDefinition,
  CapabilityContext,
} from '@evolveflow/capabilities';
import type { ConversationContext } from '../src/ai/types.js';

// ── mock registry（仿 pi-bridge/tests/bridge.test.ts 的风格）────────
function mockRegistry(caps: CapabilityDefinition[]): CapabilityRegistry {
  const map = new Map(caps.map((c) => [c.name, c]));
  return {
    list: () => Array.from(map.values()),
    get: (name: string) => map.get(name),
    has: (name: string) => map.has(name),
    register: () => {},
    listByDomain: () => [],
    getMutatingCapabilities: () => caps.filter((c) => c.mutating),
    onAfterInvoke: () => {},
    invoke: async (name: string, input: Record<string, unknown>) => ({
      success: true,
      data: { called: name, input },
    }),
  } as unknown as CapabilityRegistry;
}

const taskCreate: CapabilityDefinition = {
  name: 'task.create',
  domain: 'task',
  description: 'Create a task',
  inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
  mutating: true,
  handler: async () => ({ success: true, data: { id: 't1' } }),
};
const taskList: CapabilityDefinition = {
  name: 'task.list',
  domain: 'task',
  description: 'List tasks',
  inputSchema: { type: 'object', properties: {} },
  mutating: false,
  handler: async () => ({ success: true, data: [] }),
};

const mockCtx: ConversationContext = {
  currentDate: '2026-06-20T09:00:00',
  todayTasks: [{ id: 't1', title: '写文档', status: 'in_progress', estimatedMinutes: 60 }],
  todayEvents: [{ id: 'e1', title: '站会', startTime: '10:00', endTime: '10:30' }],
  todayBlocks: [],
  overdueTasks: [],
  workHours: { start: '09:00', end: '18:00' },
  scheduleStyle: 'balanced',
  preferences: {},
  dreamInsights: [],
  pendingReminders: 0,
  completedToday: 2,
  totalPending: 5,
};

// 把 capability 名构造成假 AgentTool，用于过滤/映射测试。
function fakeTool(name: string): AgentTool {
  return {
    name,
    label: name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: {} } as never,
    async execute() {
      return { content: [{ type: 'text', text: 'ok' }], details: {} };
    },
  } as unknown as AgentTool;
}

describe('filterToolsByMode', () => {
  it('chat 模式无工具', () => {
    const tools = [fakeTool('task.create'), fakeTool('task.list')];
    expect(filterToolsByMode(tools, 'chat')).toHaveLength(0);
  });

  it('plan 模式只保留只读（排除 mutating）', () => {
    const tools = [fakeTool('task.create'), fakeTool('task.list'), fakeTool('task.update')];
    const filtered = filterToolsByMode(tools, 'plan');
    expect(filtered.map((t) => t.name)).toEqual(['task.list']);
  });

  it('auto/yolo 模式保留全部', () => {
    const tools = [fakeTool('task.create'), fakeTool('task.list')];
    expect(filterToolsByMode(tools, 'auto')).toHaveLength(2);
    expect(filterToolsByMode(tools, 'yolo')).toHaveLength(2);
  });
});

describe('buildEvolveFlowSystemPrompt', () => {
  it('包含 <evolveflow_context> 块和 persona', () => {
    const prompt = buildEvolveFlowSystemPrompt('auto', mockCtx, [fakeTool('task.create')]);
    expect(prompt).toContain('<evolveflow_context>');
    expect(prompt).toContain('</evolveflow_context>');
    expect(prompt).toContain('当前日期时间: 2026-06-20');
    expect(prompt).toContain('写文档'); // todayTasks 渲染
    expect(prompt).toContain('站会'); // todayEvents
    expect(prompt).toContain('自动模式'); // auto persona
  });

  it('chat 模式 persona 提示无工具权限', () => {
    const prompt = buildEvolveFlowSystemPrompt('chat', mockCtx, []);
    expect(prompt).toContain('对话');
    expect(prompt).toContain('没有工具权限');
  });

  it('工具列表提示在有工具时出现', () => {
    const withTools = buildEvolveFlowSystemPrompt('auto', mockCtx, [fakeTool('task.create')]);
    expect(withTools).toContain('可用工具');
    expect(withTools).toContain('task.create');
  });
});

describe('mapAgentEventToStreamChunk', () => {
  const sid = 'sess-1';

  it('agent_start → session_start', () => {
    const chunk = mapAgentEventToStreamChunk({ type: 'agent_start' } as AgentHarnessEvent, sid);
    expect(chunk).toEqual({ session_id: sid, type: 'session_start', content: '会话已开始' });
  });

  it('agent_end → done', () => {
    const chunk = mapAgentEventToStreamChunk(
      { type: 'agent_end', messages: [] } as AgentHarnessEvent,
      sid
    );
    expect(chunk).toEqual({ session_id: sid, type: 'done', done: true });
  });

  it('tool_execution_start → tool_use_start', () => {
    const chunk = mapAgentEventToStreamChunk(
      {
        type: 'tool_execution_start',
        toolCallId: 'tc1',
        toolName: 'task.create',
        args: { title: 'x' },
      } as AgentHarnessEvent,
      sid
    );
    expect(chunk?.type).toBe('tool_use_start');
    expect(chunk?.tool_name).toBe('task.create');
    expect(chunk?.tool_use_id).toBe('tc1');
  });

  it('tool_execution_end → tool_result（成功）', () => {
    const chunk = mapAgentEventToStreamChunk(
      {
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        toolName: 'task.list',
        result: { content: [{ type: 'text', text: '[]' }], details: {} },
        isError: false,
      } as AgentHarnessEvent,
      sid
    );
    expect(chunk?.type).toBe('tool_result');
    expect(chunk?.tool_result).toBe('[]');
    expect(chunk?.error).toBeUndefined();
  });

  it('tool_execution_end → tool_result（错误）', () => {
    const chunk = mapAgentEventToStreamChunk(
      {
        type: 'tool_execution_end',
        toolCallId: 'tc1',
        toolName: 'task.create',
        result: { content: [{ type: 'text', text: '权限不足' }], details: {} },
        isError: true,
      } as AgentHarnessEvent,
      sid
    );
    expect(chunk?.type).toBe('tool_result');
    expect(chunk?.error).toBe('权限不足');
  });

  it('无关事件返回 null', () => {
    expect(mapAgentEventToStreamChunk({ type: 'turn_start' } as AgentHarnessEvent, sid)).toBeNull();
    expect(
      mapAgentEventToStreamChunk(
        { type: 'queue_update', steer: [], followUp: [] } as AgentHarnessEvent,
        sid
      )
    ).toBeNull();
  });
});

describe('HarnessManager（in-memory，无真实 LLM）', () => {
  // 不调 prompt（要真实 LLM，由 e2e 测试覆盖）。只验证 Agent 能构造、工具已注册。

  it('能创建 manager 并构建 Agent（不抛错），工具名已 sanitize', async () => {
    const registry = mockRegistry([taskCreate, taskList]);
    const capCtx: CapabilityContext = { actor: 'ai', origin: 'test', session_id: 's1' };
    const fakeModel = {
      id: 'fake',
      provider: 'faux',
      api: 'openai-completions',
      contextWindow: 64000,
      maxTokens: 4096,
    } as never;
    const manager = createInMemoryHarnessManager({
      db: {
        getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) as never }),
      } as never,
      registry,
      apiKey: 'fake-key',
      model: fakeModel,
    });
    const agent = await manager.getOrCreate('s1', 'plan', capCtx);
    expect(agent).toBeDefined();
    // plan 模式激活的工具应是只读的（task.list → task__list），不含 task.create。
    const activeNames = agent.state.tools.map((t) => t.name);
    expect(activeNames).toContain('task__list'); // sanitized
    expect(activeNames).not.toContain('task__create');
    // 工具名满足 OpenAI 约束（^[a-zA-Z0-9_-]+$）
    for (const name of activeNames) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
    await manager.disposeAll();
  });

  it('同 session 复用 agent，切 mode 重建', async () => {
    const registry = mockRegistry([taskCreate, taskList]);
    const capCtx: CapabilityContext = { actor: 'ai', origin: 'test', session_id: 's1' };
    const fakeModel = { id: 'fake', provider: 'faux', api: 'openai-completions' } as never;
    const manager = createInMemoryHarnessManager({
      db: {
        getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) as never }),
      } as never,
      registry,
      apiKey: 'fake-key',
      model: fakeModel,
    });
    const a1 = await manager.getOrCreate('s1', 'chat', capCtx);
    const a2 = await manager.getOrCreate('s1', 'chat', capCtx);
    expect(a2).toBe(a1); // 同 mode 复用
    const a3 = await manager.getOrCreate('s1', 'yolo', capCtx);
    expect(a3).not.toBe(a1); // 切 mode 重建
    await manager.disposeAll();
  });

  it('auto 模式：挂了 beforeToolCall hook（requestApproval 提供时）', async () => {
    const registry = mockRegistry([taskCreate, taskList]);
    const capCtx: CapabilityContext = { actor: 'ai', origin: 'test', session_id: 's1' };
    const fakeModel = { id: 'fake', provider: 'faux', api: 'openai-completions' } as never;
    let approvalRequested = false;
    const manager = createInMemoryHarnessManager({
      db: {
        getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) as never }),
      } as never,
      registry,
      apiKey: 'fake-key',
      model: fakeModel,
      requestApproval: async () => {
        approvalRequested = true;
        return true;
      },
    });
    const agent = await manager.getOrCreate('s1', 'auto', capCtx);
    expect(agent.beforeToolCall).toBeDefined(); // auto 模式挂了 hook
    // 模拟 mutating 工具调用（task__create）：hook 应调 requestApproval 并放行
    const resAllow = await agent.beforeToolCall!({
      toolCall: { id: 'tc1', name: 'task__create', arguments: {} } as never,
    } as never);
    expect(approvalRequested).toBe(true);
    expect(resAllow).toBeUndefined(); // 放行
    await manager.disposeAll();
  });

  it('auto 模式：requestApproval 返回 false 时 block', async () => {
    const registry = mockRegistry([taskCreate]);
    const capCtx: CapabilityContext = { actor: 'ai', origin: 'test', session_id: 's1' };
    const fakeModel = { id: 'fake', provider: 'faux', api: 'openai-completions' } as never;
    const manager = createInMemoryHarnessManager({
      db: {
        getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) as never }),
      } as never,
      registry,
      apiKey: 'fake-key',
      model: fakeModel,
      requestApproval: async () => false, // 用户拒绝
    });
    const agent = await manager.getOrCreate('s1', 'auto', capCtx);
    const res = await agent.beforeToolCall!({
      toolCall: { id: 'tc1', name: 'task__create', arguments: {} } as never,
    } as never);
    expect(res?.block).toBe(true);
    expect(res?.reason).toContain('用户拒绝');
    await manager.disposeAll();
  });

  it('auto 模式：只读工具（task.list）不经确认直接放行', async () => {
    const registry = mockRegistry([taskCreate, taskList]);
    const capCtx: CapabilityContext = { actor: 'ai', origin: 'test', session_id: 's1' };
    const fakeModel = { id: 'fake', provider: 'faux', api: 'openai-completions' } as never;
    let requested = false;
    const manager = createInMemoryHarnessManager({
      db: {
        getDb: () => ({ prepare: () => ({ all: () => [], get: () => undefined }) as never }),
      } as never,
      registry,
      apiKey: 'fake-key',
      model: fakeModel,
      requestApproval: async () => {
        requested = true;
        return true;
      },
    });
    const agent = await manager.getOrCreate('s1', 'auto', capCtx);
    const res = await agent.beforeToolCall!({
      toolCall: { id: 'tc1', name: 'task__list', arguments: {} } as never,
    } as never);
    expect(requested).toBe(false); // 只读不确认
    expect(res).toBeUndefined(); // 放行
    await manager.disposeAll();
  });
});
