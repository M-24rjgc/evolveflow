/**
 * EvolveFlow AI 常量（精简版）。
 *
 * 旧的 DeepSeek Anthropic 端点常量（DEEPSEEK_ANTHROPIC_BASE_URL 等）随旧 ApiClient 删除。
 * pi 路径用 DeepSeek 的 OpenAI 兼容端点（model id 'deepseek-v4-pro'，见 sidecar-pi-bridge）。
 * 这里只保留 AgentMode 类型和 API key 解析（其他模块仍用）。
 */

export type AgentMode = 'chat' | 'plan' | 'auto' | 'yolo';

/** 从环境变量取 DeepSeek API key（兼容 EVOLVEFLOW_AI_KEY / DEEPSEEK_API_KEY）。 */
export function getEnvDeepSeekApiKey(env: NodeJS.ProcessEnv = process.env): string {
  return env.EVOLVEFLOW_AI_KEY || env.DEEPSEEK_API_KEY || '';
}
