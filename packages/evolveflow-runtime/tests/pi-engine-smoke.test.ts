// Smoke test: real DeepSeek call via pi engine. Not committed with a key.
// Run: DEEPSEEK_API_KEY=... npx vitest run packages/evolveflow-runtime/tests/pi-engine-smoke.test.ts
import { describe, it, expect } from 'vitest';
import { createPiEngine } from '../src/pi-engine.js';

// Build a registry mock with one read-only capability so the agent has a tool
// to play with, without needing a real database.
function mockRegistry() {
  const caps = [
    {
      name: 'echo',
      domain: 'test',
      description: 'Echo back the provided text. Use when the user asks to echo.',
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      mutating: false,
      handler: async (input: Record<string, unknown>) => ({
        success: true,
        data: { echoed: input.text },
      }),
    },
  ];
  const map = new Map(caps.map((c) => [c.name, c]));
  return {
    list: () => Array.from(map.values()),
    get: (n: string) => map.get(n),
    has: (n: string) => map.has(n),
    invoke: async (n: string, input: Record<string, unknown>) => {
      const c = map.get(n);
      return c
        ? c.handler(input, { actor: 'ai', origin: 'test' })
        : { success: false, error: 'not found' };
    },
  } as never;
}

describe('pi-engine smoke (real DeepSeek)', () => {
  it.skipIf(!process.env.DEEPSEEK_API_KEY)(
    'runs a one-turn agent call against DeepSeek',
    async () => {
      const engine = createPiEngine({
        apiKey: process.env.DEEPSEEK_API_KEY,
        registry: mockRegistry(),
        capabilityContext: { actor: 'ai', origin: 'test' },
        systemPrompt:
          'You are a test assistant. When the user asks to echo something, use the echo tool.',
      });

      const messages = await engine.run('Please echo the text "hello pi"', [], undefined);
      // Assert: got messages back from a real provider round-trip.
      expect(messages.length).toBeGreaterThan(0);
      // Capture the full transcript for diagnostic visibility.
      const transcript = messages
        .map(
          (m) =>
            `[${m.role}] ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content).slice(0, 200)}`
        )
        .join('\n');
      // Must contain non-empty assistant text (proves a real LLM response, not a no-op).
      expect(transcript.length).toBeGreaterThan(20);
      // Diagnostic: print so we can confirm real content flowed through.
      console.log('--- pi-engine transcript ---\n' + transcript + '\n--- end ---');
    },
    60000
  );
});
