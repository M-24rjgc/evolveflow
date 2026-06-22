/**
 * EvolveFlow Agent 模式定义（在 pi 内部，因为 pi 已是项目源码）。
 *
 * 4 个 mode 决定工具集与权限矩阵：
 * - chat：纯对话，无工具
 * - plan：只读能力工具
 * - auto：全部能力工具，mutating 工具调前确认（经 hook）
 * - yolo：全部能力工具，全放行
 */

export type EvolveFlowAgentMode = 'chat' | 'plan' | 'auto' | 'yolo';

const VALID_MODES = new Set<EvolveFlowAgentMode>(['chat', 'plan', 'auto', 'yolo']);

export function resolveEvolveFlowMode(value: unknown, fallback: EvolveFlowAgentMode): EvolveFlowAgentMode {
  const mode = String(value || fallback).toLowerCase() as EvolveFlowAgentMode;
  return VALID_MODES.has(mode) ? mode : fallback;
}

/** 能力工具名（原始形式 'task.create'）是否为变更操作。 */
export function isMutatingCapabilityName(origName: string): boolean {
  const action = origName.split('.').pop() ?? '';
  const mutatingActions = new Set([
    'create', 'update', 'delete', 'cancel', 'complete', 'defer',
    'lock', 'unlock', 'clear', 'revert', 'snooze', 'run', 'set',
    'plan_day', 'plan_range', 'rebalance', 'restore',
    'clear_ai_history', 'clear_learned_state',
  ]);
  return mutatingActions.has(action);
}
