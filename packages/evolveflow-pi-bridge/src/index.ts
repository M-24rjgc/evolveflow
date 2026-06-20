/**
 * @evolveflow/pi-bridge
 *
 * Bridge that exposes EvolveFlow's CapabilityRegistry as pi AgentTools.
 *
 * Each capability becomes a tool the pi agent loop can call. The tool's
 * `execute` forwards to `registry.invoke()`, so the agent drives the same
 * audited, undoable, idempotent capability layer that the UI uses — no
 * second code path.
 *
 * See ADR-0007 (pi as agent base) and decision-map #3 (coexistence).
 */

import { Type, type TSchema } from 'typebox';
import type { AgentTool, AgentToolResult } from '@evolveflow/vendor-pi-agent';
import type {
  CapabilityRegistry,
  CapabilityContext,
  CapabilityDefinition,
  CapabilityResult,
} from '@evolveflow/capabilities';

/** Default tool options. */
export interface BridgeOptions {
  /**
   * Optional filter; return true to expose a capability as a tool, false to skip.
   * Defaults to exposing everything in the registry.
   */
  filter?: (cap: CapabilityDefinition) => boolean;
  /**
   * Prefix applied to tool names to avoid collisions with pi's built-in tools.
   * Defaults to "" (no prefix) — capability names like "task.create" are already namespaced.
   */
  namePrefix?: string;
}

/**
 * Convert a capability's JSON-Schema-like inputSchema into a typebox TSchema.
 *
 * `Type.Unsafe(jsonSchema)` wraps an arbitrary JSON Schema object as a TSchema
 * without re-validating its shape. pi-ai forwards the schema to the model
 * verbatim, so the model sees the same constraints the registry will enforce
 * on invoke. This is the lowest-risk conversion: no hand-rolled traversal,
 * no information loss.
 */
export function inputSchemaToParameters(inputSchema: Record<string, unknown>): TSchema {
  // typebox Type.Unsafe accepts a JSON Schema object and returns a TSchema.
  // We assert the shape; pi-ai only reads standard JSON Schema fields.
  return Type.Unsafe(inputSchema) as TSchema;
}

/**
 * Serialize a CapabilityResult into pi's AgentToolResult shape.
 *
 * On success: stringify data as text content (the model reads text).
 * On failure: put the error message in content and mark details.error.
 */
function resultToToolResult(
  result: CapabilityResult
): AgentToolResult<{ success: boolean; error?: string; data?: unknown }> {
  if (result.success) {
    return {
      content: [
        {
          type: 'text',
          text:
            typeof result.data === 'string'
              ? result.data
              : JSON.stringify(result.data ?? { ok: true }),
        },
      ],
      details: { success: true, data: result.data },
    };
  }
  const text = result.error ?? 'Capability failed with no error message';
  return {
    content: [{ type: 'text', text }],
    details: { success: false, error: result.error },
  };
}

/**
 * Build a single AgentTool from a capability definition.
 *
 * The tool's execute() forwards to registry.invoke(), carrying the supplied
 * CapabilityContext (actor/origin/session) so every agent-driven mutation is
 * audited and undoable through the normal action_log path.
 */
export function capabilityToAgentTool(
  registry: CapabilityRegistry,
  cap: CapabilityDefinition,
  context: CapabilityContext,
  namePrefix = ''
): AgentTool<TSchema> {
  const toolName = `${namePrefix}${cap.name}`;
  return {
    name: toolName,
    label: cap.name,
    description: cap.description,
    parameters: inputSchemaToParameters(cap.inputSchema),
    async execute(toolCallId, params, _signal, _onUpdate) {
      // Forward to the audited capability layer. The idempotency key uses the
      // toolCallId so retries of the same tool call are deduplicated.
      const result = await registry.invoke(cap.name, params as Record<string, unknown>, {
        ...context,
        idempotency_key:
          context.idempotency_key ?? `agent:${context.session_id ?? 'anon'}:${toolCallId}`,
      });
      return resultToToolResult(result);
    },
  };
}

/**
 * Convert every capability in a registry into pi AgentTools.
 *
 * Use this to populate `AgentContext.tools` / `AgentLoopConfig.tools` before
 * calling pi's `runAgentLoop`.
 *
 * @example
 * ```ts
 * const tools = capabilitiesToAgentTools(registry, {
 *   actor: 'ai',
 *   origin: 'ai_page',
 *   session_id: 'sess-1',
 * });
 * const context: AgentContext = { systemPrompt, messages, tools };
 * await runAgentLoop(prompts, context, config, emit);
 * ```
 */
export function capabilitiesToAgentTools(
  registry: CapabilityRegistry,
  context: CapabilityContext,
  options: BridgeOptions = {}
): AgentTool[] {
  const { filter, namePrefix = '' } = options;
  const caps = registry.list();
  const exposed = filter ? caps.filter(filter) : caps;
  return exposed.map((cap) => capabilityToAgentTool(registry, cap, context, namePrefix));
}
