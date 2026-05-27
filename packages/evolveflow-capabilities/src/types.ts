import type { Actor, Origin } from '@evolveflow/domain';

export interface CapabilityContext {
  actor: Actor;
  origin: Origin;
  idempotency_key?: string;
  session_id?: string;
}

export interface CapabilityResult {
  success: boolean;
  data?: unknown;
  error?: string;
  action_log_id?: string;
  revision?: number;
}

export interface CapabilityDefinition {
  name: string;
  domain: string;
  description: string;
  inputSchema: Record<string, unknown>;
  mutating: boolean;
  handler: (input: Record<string, unknown>, context: CapabilityContext) => Promise<CapabilityResult>;
}
