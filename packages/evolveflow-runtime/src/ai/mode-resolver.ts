/**
 * Agent mode 解析（从 sidecar.ts 抽出，供 pi 路径复用）。
 */

import type { AgentMode } from './deepseek.js';

const AGENT_MODES = new Set<AgentMode>(['chat', 'plan', 'auto', 'yolo']);

export function resolveAgentMode(value: unknown, fallback: AgentMode): AgentMode {
  const mode = String(value || fallback).toLowerCase() as AgentMode;
  return AGENT_MODES.has(mode) ? mode : fallback;
}
