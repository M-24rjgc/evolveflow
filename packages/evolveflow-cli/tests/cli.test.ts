import { describe, it, expect } from 'vitest';
import { createCliAgent } from '../src/agent.js';

describe('CLI agent configuration', () => {
  it('使用 pi 路径的 DeepSeek 合约（OpenAI 兼容端点 + v4-pro）', () => {
    const agent = createCliAgent();
    const { status } = agent;
    expect(status.provider).toBe('DeepSeek');
    // pi 路径用 deepseek-v4-pro（OpenAI 兼容端点），非旧的 deepseek-v4-flash/Anthropic 端点。
    expect(status.model).toBe('deepseek-v4-pro');
    expect(status.baseUrl).toBe('https://api.deepseek.com');
    agent.close();
  });
});
