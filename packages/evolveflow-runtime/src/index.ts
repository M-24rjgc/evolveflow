// EvolveFlow runtime 包入口。
// AI 逻辑全在 pi 包内部（evolveflow-vendor-pi-agent/src/harness/evolveflow/）。
// runtime 只提供：数据层（context/types）、Dream/Buddy 编排、AI 胶水（ai-pi-glue）。

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
// AI 胶水（runtime 侧极薄层，调 pi 包集成）
export { piComplete } from './ai/ai-pi-glue.js';
export type { AiCompleter } from './ai/ai-pi-glue.js';
