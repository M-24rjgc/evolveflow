import type { CapabilityDefinition, CapabilityContext, CapabilityResult } from './types.js';

export class CapabilityRegistry {
  private capabilities: Map<string, CapabilityDefinition> = new Map();

  register(definition: CapabilityDefinition): void {
    if (this.capabilities.has(definition.name)) {
      throw new Error(`Capability already registered: ${definition.name}`);
    }
    this.capabilities.set(definition.name, definition);
  }

  get(name: string): CapabilityDefinition | undefined {
    return this.capabilities.get(name);
  }

  has(name: string): boolean {
    return this.capabilities.has(name);
  }

  list(): CapabilityDefinition[] {
    return Array.from(this.capabilities.values());
  }

  listByDomain(domain: string): CapabilityDefinition[] {
    return this.list().filter((c) => c.domain === domain);
  }

  getMutatingCapabilities(): CapabilityDefinition[] {
    return this.list().filter((c) => c.mutating);
  }

  async invoke(name: string, input: Record<string, unknown>, context: CapabilityContext): Promise<CapabilityResult> {
    const capability = this.capabilities.get(name);
    if (!capability) {
      return { success: false, error: `Capability not found: ${name}` };
    }

    const validationError = this.validateInput(capability, input);
    if (validationError) {
      return { success: false, error: validationError };
    }

    if (context.idempotency_key) {
      const cached = this.checkIdempotency(context.idempotency_key);
      if (cached) {
        return cached;
      }
    }

    const result = await capability.handler(input, context);

    if (result.success && context.idempotency_key) {
      this.cacheIdempotency(context.idempotency_key, result);
    }

    return result;
  }

  private idempotencyCache: Map<string, { result: CapabilityResult; timestamp: number }> = new Map();
  private static MAX_CACHE_SIZE = 10000;
  private static CACHE_TTL_MS = 3600000;

  private validateInput(capability: CapabilityDefinition, input: Record<string, unknown>): string | null {
    const schema = capability.inputSchema;
    if (!schema.properties) return null;

    const required = (schema.required as string[]) ?? [];
    for (const field of required) {
      if (input[field] === undefined || input[field] === null) {
        return `Missing required field: ${field}`;
      }
    }

    return null;
  }

  private checkIdempotency(key: string): CapabilityResult | null {
    const entry = this.idempotencyCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.timestamp > CapabilityRegistry.CACHE_TTL_MS) {
      this.idempotencyCache.delete(key);
      return null;
    }
    return entry.result;
  }

  private cacheIdempotency(key: string, result: CapabilityResult): void {
    if (this.idempotencyCache.size >= CapabilityRegistry.MAX_CACHE_SIZE) {
      const oldestKey = this.idempotencyCache.keys().next().value;
      if (oldestKey) this.idempotencyCache.delete(oldestKey);
    }
    this.idempotencyCache.set(key, { result, timestamp: Date.now() });
  }
}
