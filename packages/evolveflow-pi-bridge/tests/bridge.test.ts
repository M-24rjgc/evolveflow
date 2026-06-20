import { describe, it, expect, vi } from 'vitest';
import {
  capabilitiesToAgentTools,
  capabilityToAgentTool,
  inputSchemaToParameters,
} from '../src/index.js';
import type {
  CapabilityRegistry,
  CapabilityDefinition,
  CapabilityContext,
  CapabilityResult,
} from '@evolveflow/capabilities';

/** Minimal in-memory CapabilityRegistry mock for bridge tests. */
function mockRegistry(caps: CapabilityDefinition[]): CapabilityRegistry {
  const map = new Map(caps.map((c) => [c.name, c]));
  return {
    list: () => Array.from(map.values()),
    get: (name: string) => map.get(name),
    has: (name: string) => map.has(name),
    register: () => {},
    listByDomain: () => [],
    getMutatingCapabilities: () => caps.filter((c) => c.mutating),
    onAfterInvoke: () => {},
    invoke: vi.fn(
      async (
        name: string,
        input: Record<string, unknown>,
        _ctx: CapabilityContext
      ): Promise<CapabilityResult> => {
        // Echo back which capability was called and with what input, so tests
        // can assert the bridge forwarded correctly.
        return { success: true, data: { called: name, input } };
      }
    ),
  } as unknown as CapabilityRegistry;
}

const baseCtx: CapabilityContext = {
  actor: 'ai',
  origin: 'ai_page',
  session_id: 'sess-1',
};

const taskCreate: CapabilityDefinition = {
  name: 'task.create',
  domain: 'task',
  description: 'Create a new task',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      duration_minutes: { type: 'number' },
    },
    required: ['title'],
  },
  mutating: true,
  handler: async () => ({ success: true, data: { id: 't1' } }),
};

const taskList: CapabilityDefinition = {
  name: 'task.list',
  domain: 'task',
  description: 'List tasks',
  inputSchema: { type: 'object', properties: {} },
  mutating: false,
  handler: async () => ({ success: true, data: [] }),
};

describe('inputSchemaToParameters', () => {
  it('wraps a JSON Schema object as a typebox TSchema', () => {
    const schema = { type: 'object', properties: { a: { type: 'string' } }, required: ['a'] };
    const params = inputSchemaToParameters(schema);
    // Type.Unsafe carries the source object through; pi-ai reads it verbatim.
    expect(params).toBeTruthy();
    // The unsafe schema retains a symbol key from typebox; just assert shape sanity.
    expect(typeof params).toBe('object');
  });
});

describe('capabilityToAgentTool', () => {
  it('maps name/description/parameters onto the AgentTool', () => {
    const registry = mockRegistry([taskCreate]);
    const tool = capabilityToAgentTool(registry, taskCreate, baseCtx);
    expect(tool.name).toBe('task.create');
    expect(tool.label).toBe('task.create');
    expect(tool.description).toBe('Create a new task');
    expect(tool.parameters).toBeTruthy();
    expect(typeof tool.execute).toBe('function');
  });

  it('execute forwards to registry.invoke and serializes success data', async () => {
    const registry = mockRegistry([taskCreate]);
    const tool = capabilityToAgentTool(registry, taskCreate, baseCtx);
    const result = await tool.execute('toolu_1', { title: 'Write tests' } as never);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toMatchObject({ type: 'text' });
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain('called');
    expect(text).toContain('task.create');
    expect(text).toContain('Write tests');
    // invoke was called with the capability name, params, and an idempotency key.
    expect(registry.invoke).toHaveBeenCalledWith(
      'task.create',
      { title: 'Write tests' },
      expect.objectContaining({
        actor: 'ai',
        origin: 'ai_page',
        idempotency_key: expect.stringContaining('agent:sess-1:toolu_1'),
      })
    );
  });

  it('execute serializes a failed capability as error text', async () => {
    const failing: CapabilityDefinition = {
      ...taskCreate,
      name: 'task.fail',
      handler: async () => ({ success: false, error: 'boom' }),
    };
    const registry = mockRegistry([failing]);
    // Override invoke to return failure for this cap.
    (registry.invoke as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      success: false,
      error: 'boom',
    });
    const tool = capabilityToAgentTool(registry, failing, baseCtx);
    const result = await tool.execute('toolu_2', {} as never);
    expect(result.content[0]).toMatchObject({ type: 'text', text: 'boom' });
    expect(result.details).toMatchObject({ success: false, error: 'boom' });
  });
});

describe('capabilitiesToAgentTools', () => {
  it('exposes every capability when no filter is given', () => {
    const registry = mockRegistry([taskCreate, taskList]);
    const tools = capabilitiesToAgentTools(registry, baseCtx);
    expect(tools).toHaveLength(2);
    expect(tools.map((t) => t.name).sort()).toEqual(['task.create', 'task.list']);
  });

  it('filter excludes capabilities', () => {
    const registry = mockRegistry([taskCreate, taskList]);
    const tools = capabilitiesToAgentTools(registry, baseCtx, {
      filter: (c) => !c.mutating,
    });
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('task.list');
  });

  it('namePrefix is applied to tool names', () => {
    const registry = mockRegistry([taskCreate]);
    const tools = capabilitiesToAgentTools(registry, baseCtx, { namePrefix: 'ev_' });
    expect(tools[0].name).toBe('ev_task.create');
  });
});
