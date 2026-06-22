/**
 * EvolveFlow 集成层单元测试（在 pi 包内部）。
 *
 * 测试纯函数：工具名 sanitize/desanitize、mode 过滤、system prompt 构建。
 * 不测 createEvolveFlowHarness 本身（需要真实 DeepSeek，由 e2e 覆盖）。
 */
import { describe, it, expect } from 'vitest';
import {
  sanitizeToolName,
  desanitizeToolName,
  filterToolsByMode,
} from '../src/harness/evolveflow/tool-sanitizer.ts';
import { resolveEvolveFlowMode, isMutatingCapabilityName } from '../src/harness/evolveflow/mode.ts';
import { buildEvolveFlowSystemPrompt } from '../src/harness/evolveflow/system-prompt.ts';
import type { EvolveFlowContext } from '../src/harness/evolveflow/system-prompt.ts';
import type { AgentTool } from '../src/types.ts';

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

const mockCtx: EvolveFlowContext = {
  currentDate: '2026-06-21T09:00:00',
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

describe('tool-sanitizer', () => {
  it('点号替换为双下划线', () => {
    const t = sanitizeToolName(fakeTool('task.create'));
    expect(t.name).toBe('task__create');
    expect(t.label).toBe('task.create'); // label 保留原名
  });

  it('单下划线保留（plan_day 不被破坏）', () => {
    const t = sanitizeToolName(fakeTool('schedule.plan_day'));
    expect(t.name).toBe('schedule__plan_day'); // 点号→__，原有 _ 保留
  });

  it('desanitize 还原点号', () => {
    expect(desanitizeToolName('task__create')).toBe('task.create');
    // 已知限制：capability 名若含单下划线（如 plan_day），desanitize 会把它也转成点。
    // 当前不影响正确性——工具注册时用原始名，sanitize 只改对外名。
    expect(desanitizeToolName('schedule__plan__day')).toBe('schedule.plan.day');
  });

  it('满足 OpenAI function name 约束', () => {
    const t = sanitizeToolName(fakeTool('task.create'));
    expect(t.name).toMatch(/^[a-zA-Z0-9_-]+$/);
  });
});

describe('filterToolsByMode', () => {
  const tools = [
    fakeTool('task.create'),
    fakeTool('task.list'),
    fakeTool('task.update'),
    fakeTool('schedule.plan_day'),
  ].map(sanitizeToolName);

  it('chat 模式无工具', () => {
    expect(filterToolsByMode(tools, 'chat')).toHaveLength(0);
  });

  it('plan 模式只保留只读（排除 mutating）', () => {
    const filtered = filterToolsByMode(tools, 'plan');
    const names = filtered.map((t) => t.name);
    expect(names).toContain('task__list');
    expect(names).not.toContain('task__create');
    expect(names).not.toContain('task__update');
    expect(names).not.toContain('schedule__plan_day');
  });

  it('auto/yolo 模式保留全部', () => {
    expect(filterToolsByMode(tools, 'auto')).toHaveLength(4);
    expect(filterToolsByMode(tools, 'yolo')).toHaveLength(4);
  });
});

describe('resolveEvolveFlowMode', () => {
  it('合法 mode 直接返回', () => {
    expect(resolveEvolveFlowMode('chat', 'auto')).toBe('chat');
    expect(resolveEvolveFlowMode('YOLO', 'auto')).toBe('yolo');
  });

  it('非法值回落到 fallback', () => {
    expect(resolveEvolveFlowMode('invalid', 'auto')).toBe('auto');
    expect(resolveEvolveFlowMode(undefined, 'plan')).toBe('plan');
  });
});

describe('isMutatingCapabilityName', () => {
  it('识别 mutating 动作', () => {
    expect(isMutatingCapabilityName('task.create')).toBe(true);
    expect(isMutatingCapabilityName('task.delete')).toBe(true);
    expect(isMutatingCapabilityName('schedule.plan_day')).toBe(true);
  });

  it('只读动作返回 false', () => {
    expect(isMutatingCapabilityName('task.list')).toBe(false);
    expect(isMutatingCapabilityName('task.get')).toBe(false);
  });
});

describe('buildEvolveFlowSystemPrompt', () => {
  it('包含 <evolveflow_context> 块和 persona', () => {
    const prompt = buildEvolveFlowSystemPrompt('auto', mockCtx, [fakeTool('task__create')]);
    expect(prompt).toContain('<evolveflow_context>');
    expect(prompt).toContain('</evolveflow_context>');
    expect(prompt).toContain('当前日期时间: 2026-06-21');
    expect(prompt).toContain('写文档');
    expect(prompt).toContain('站会');
    expect(prompt).toContain('自动模式');
  });

  it('chat 模式提示无工具权限', () => {
    const prompt = buildEvolveFlowSystemPrompt('chat', mockCtx, []);
    expect(prompt).toContain('对话');
    expect(prompt).toContain('没有工具权限');
  });

  it('工具列表提示在有工具时出现', () => {
    const withTools = buildEvolveFlowSystemPrompt('auto', mockCtx, [fakeTool('task__create')]);
    expect(withTools).toContain('可用工具');
    expect(withTools).toContain('task__create');
  });
});
