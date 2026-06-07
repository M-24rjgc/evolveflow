import { describe, it, expect } from 'vitest';
import { DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_MODEL, DEEPSEEK_PROVIDER } from '../src/agent.js';

describe('CLI agent configuration', () => {
  it('uses the fixed DeepSeek-V4-Flash contract', () => {
    expect(DEEPSEEK_PROVIDER).toBe('DeepSeek');
    expect(DEEPSEEK_MODEL).toBe('deepseek-v4-flash');
    expect(DEEPSEEK_ANTHROPIC_BASE_URL).toBe('https://api.deepseek.com/anthropic');
  });
});
