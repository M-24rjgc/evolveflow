/**
 * EvolveFlow 集成层（在 pi 包内部）。
 *
 * pi vendor 进来就是项目源码。EvolveFlow 的 AI 定制直接写在这里，
 * 用 pi 原生 AgentHarness + Session/jsonl，经接缝注入。
 * runtime 侧只有极薄胶水调用这里的 createEvolveFlowHarness。
 */

export {
  createEvolveFlowHarness,
  resolveEvolveFlowMode,
  sanitizeToolName,
  desanitizeToolName,
  filterToolsByMode,
  createEvolveFlowNativeTools,
  buildEvolveFlowSystemPrompt,
} from './create-evolveflow-harness.ts';

export type {
  EvolveFlowAgentMode,
  EvolveFlowContext,
  CreateEvolveFlowHarnessInput,
  EvolveFlowChunk,
  EvolveFlowSessionMeta,
  RequestApprovalFn,
} from './create-evolveflow-harness.ts';
