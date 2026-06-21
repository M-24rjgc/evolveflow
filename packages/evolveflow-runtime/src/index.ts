// EvolveFlow runtime 包入口。
// 旧 AI 代码（loop/client/tools/AnthropicTool）已删除，AI 路径改用 pi Agent（见 ai/ 目录）。

export {
  CAPABILITIES,
  CAPABILITY_NAMES,
  getCapability,
  isMutatingCapability,
} from './capabilities.js';
export type { CapabilityDefinition } from './capabilities.js';
export { getScheduleSkillPrompt } from './skills/schedule-skill.js';
export { DreamOrchestrator } from './dream.js';
export type {
  DreamConfig,
  DreamRunResult,
  DreamAnalysisResult,
  DreamInsight,
  DreamPreferences,
  DreamData,
} from './dream.js';
export { BuddyCore, BuddyCliRenderer } from './buddy.js';
export type { BuddyLevel, BuddyState } from './buddy.js';
export { getEnvDeepSeekApiKey } from './ai/deepseek.js';
export type { AgentMode } from './ai/deepseek.js';
export { buildConversationContext } from './ai/context.js';
export type { AiStreamChunk, ConversationContext } from './ai/types.js';
// pi Agent 路径入口
export { HarnessManager, createInMemoryHarnessManager } from './ai/harness-manager.js';
export { SessionStore } from './ai/session-store.js';
export { createPiCompleter } from './ai/sidecar-pi-bridge.js';
export type { AiCompleter } from './ai/sidecar-pi-bridge.js';
export { createEvolveFlowNativeTools } from './ai/native-tools.js';
