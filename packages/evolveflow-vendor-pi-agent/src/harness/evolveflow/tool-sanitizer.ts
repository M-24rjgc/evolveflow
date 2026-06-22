/**
 * 工具名清洗：DeepSeek 的 OpenAI 兼容端点要求 function name 匹配 ^[a-zA-Z0-9_-]+$，
 * 不允许点号。EvolveFlow 能力工具名形如 'task.create'，需转成 'task__create'。
 * 用双下划线替换点号（避免与 capability 名里原有单下划线如 plan_day 冲突）。
 *
 * 注：execute 闭包内仍用原始 capability 名调 registry，所以只改对外的 name/label。
 */
import type { AgentTool } from '../../types.ts';

/** 'task.create' → 'task__create'；'schedule.plan_day' → 'schedule__plan_day'。 */
export function sanitizeToolName<T extends AgentTool>(tool: T): T {
  const sanitizedName = tool.name.replace(/\./g, '__').replace(/[^a-zA-Z0-9_-]/g, '_');
  return { ...tool, name: sanitizedName, label: tool.label ?? tool.name };
}

/** 'task__create' → 'task.create'（还原给前端/审计）。 */
export function desanitizeToolName(name: string): string {
  return name.replace(/__/g, '.');
}

/** 批量清洗。 */
export function sanitizeToolNames<T extends AgentTool>(tools: T[]): T[] {
  return tools.map(sanitizeToolName);
}

/** 按 mode 过滤工具（chat 无工具；plan 只读；auto/yolo 全部）。 */
export function filterToolsByMode<T extends AgentTool>(tools: T[], mode: string): T[] {
  switch (mode) {
    case 'chat':
      return [];
    case 'plan':
      return tools.filter((t) => {
        const orig = desanitizeToolName(t.name);
        return !isMutatingCapabilityName(orig);
      });
    case 'auto':
    case 'yolo':
      return tools;
    default:
      return tools;
  }
}

function isMutatingCapabilityName(origName: string): boolean {
  const action = origName.split('.').pop() ?? '';
  const mutatingActions = new Set([
    'create', 'update', 'delete', 'cancel', 'complete', 'defer',
    'lock', 'unlock', 'clear', 'revert', 'snooze', 'run', 'set',
    'plan_day', 'plan_range', 'rebalance', 'restore',
    'clear_ai_history', 'clear_learned_state',
  ]);
  return mutatingActions.has(action);
}
