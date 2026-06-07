export const DEEPSEEK_PROVIDER = 'DeepSeek';
export const DEEPSEEK_MODEL = 'deepseek-v4-flash';
export const DEEPSEEK_MODEL_DISPLAY = 'DeepSeek-V4-Flash';
export const DEEPSEEK_ANTHROPIC_BASE_URL = 'https://api.deepseek.com/anthropic';

export type AgentMode = 'chat' | 'plan' | 'auto' | 'yolo';

export interface DeepSeekRuntimeConfig {
  provider: typeof DEEPSEEK_PROVIDER;
  model: typeof DEEPSEEK_MODEL;
  modelDisplay: typeof DEEPSEEK_MODEL_DISPLAY;
  baseUrl: typeof DEEPSEEK_ANTHROPIC_BASE_URL;
}

export function getDeepSeekRuntimeConfig(): DeepSeekRuntimeConfig {
  return {
    provider: DEEPSEEK_PROVIDER,
    model: DEEPSEEK_MODEL,
    modelDisplay: DEEPSEEK_MODEL_DISPLAY,
    baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
  };
}

export function getEnvDeepSeekApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.EVOLVEFLOW_AI_KEY || env.DEEPSEEK_API_KEY || '';
}

export function getThinkingForMode(
  mode: AgentMode,
  fast = false
): { type: 'enabled' } | { type: 'disabled' } {
  if (fast || mode === 'chat') {
    return { type: 'disabled' };
  }
  return { type: 'enabled' };
}
