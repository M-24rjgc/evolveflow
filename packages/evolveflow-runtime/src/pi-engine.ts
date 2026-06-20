/**
 * pi-engine: wraps pi's runAgentLoop with EvolveFlow's CapabilityRegistry
 * exposed as tools, and DeepSeek as the model.
 *
 * This replaces the hand-written DeepSeek loop (initAiEngine + runConversation).
 * It is intentionally a small, self-contained module so sidecar.ts can adopt it
 * incrementally and the old path stays available until step 4 removes it.
 *
 * See ADR-0007 (pi as base), decision-map #3 (coexistence), PRD step 3.
 */

import {
  getModel,
  streamSimple,
  type Model,
  type Message,
  type Context as LlmContext,
} from '@evolveflow/vendor-pi-ai';
import {
  runAgentLoop,
  type AgentMessage,
  type AgentContext,
  type AgentLoopConfig,
  type AgentEvent,
  type AgentEventSink,
} from '@evolveflow/vendor-pi-agent';
import { capabilitiesToAgentTools, type BridgeOptions } from '@evolveflow/pi-bridge';
import type { CapabilityRegistry, CapabilityContext } from '@evolveflow/capabilities';

/** Default DeepSeek model id used by EvolveFlow. */
export const DEFAULT_MODEL_ID = 'deepseek-v4-pro';
/** DeepSeek provider id in pi-ai's built-in registry. */
export const DEEPSEEK_PROVIDER = 'deepseek';

export interface PiEngineOptions {
  /** DeepSeek API key. If omitted, pi-ai falls back to DEEPSEEK_API_KEY env. */
  apiKey?: string;
  /** Model id within the deepseek provider. Defaults to deepseek-v4-pro. */
  modelId?: string;
  /** The EvolveFlow capability registry whose capabilities become agent tools. */
  registry: CapabilityRegistry;
  /** Capability context (actor/origin/session) carried into every invoke. */
  capabilityContext: CapabilityContext;
  /** Bridge options (filter/prefix). */
  bridgeOptions?: BridgeOptions;
  /** System prompt for the agent. */
  systemPrompt?: string;
}

export interface PiEngine {
  /** The resolved model object. */
  readonly model: Model<any>;
  /**
   * Run the agent loop for one user turn. Yields AgentEvents as they are
   * emitted by pi (agent_start, message_start, message_end, tool_call,
   * tool_result, turn_end, agent_end, ...).
   *
   * Tools are sourced from the capability registry on each call so newly
   * registered capabilities are picked up.
   */
  run(userText: string, history: AgentMessage[], signal?: AbortSignal): Promise<AgentMessage[]>;
  /** Build a fresh tool list from the registry (exposed for testing). */
  tools(): ReturnType<typeof capabilitiesToAgentTools>;
}

/**
 * Create a pi-backed agent engine bound to DeepSeek and the EvolveFlow
 * capability registry. Throws if the model id is unknown to pi-ai.
 */
export function createPiEngine(options: PiEngineOptions): PiEngine {
  const {
    apiKey,
    modelId = DEFAULT_MODEL_ID,
    registry,
    capabilityContext,
    bridgeOptions,
    systemPrompt = '',
  } = options;

  // Resolve the DeepSeek model. getModel throws if provider/model unknown.
  const model = getModel(DEEPSEEK_PROVIDER as never, modelId as never) as Model<any>;

  // Default convertToLlm: pass AgentMessages through as LLM Messages.
  // pi's standard AgentMessage roles (user/assistant/tool_result) already
  // satisfy pi-ai's Message type; custom roles would need filtering here.
  const convertToLlm = (messages: AgentMessage[]): Message[] => {
    return messages as unknown as Message[];
  };

  const buildConfig = (): AgentLoopConfig => ({
    model,
    convertToLlm,
    // Provide the API key dynamically so short-lived keys could be supported
    // later; for now it's a constant.
    getApiKey: async () => apiKey,
  });

  const buildContext = (): AgentContext => ({
    systemPrompt,
    messages: [],
    tools: capabilitiesToAgentTools(registry, capabilityContext, bridgeOptions),
  });

  return {
    model,
    tools() {
      return capabilitiesToAgentTools(registry, capabilityContext, bridgeOptions);
    },
    async run(userText, history, signal) {
      const userMessage: AgentMessage = {
        role: 'user',
        content: [{ type: 'text', text: userText }],
        timestamp: Date.now(),
      } as unknown as AgentMessage;

      const context: AgentContext = {
        ...buildContext(),
        messages: [...history, userMessage],
      };

      // AgentEventSink that discards events. sidecar will pass a real sink
      // (forwarding to JSON-RPC notifications) when it adopts this engine.
      const noopSink: AgentEventSink = async () => {};

      // streamFn delegates to pi-ai's streamSimple, bound to the resolved model.
      // StreamFn signature mirrors streamSimple(model, context, options).
      const streamFn = (ctx: AgentContext, cfg: AgentLoopConfig) => {
        const llmContext: LlmContext = {
          systemPrompt: ctx.systemPrompt,
          messages: ctx.messages as unknown as Message[],
          tools: ctx.tools,
        };
        return streamSimple(model, llmContext, cfg as never);
      };

      return runAgentLoop(
        [userMessage],
        context,
        buildConfig(),
        noopSink,
        signal,
        streamFn as never
      );
    },
  };
}
