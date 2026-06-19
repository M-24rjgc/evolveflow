import type { CapabilityDefinition, CapabilityContext, CapabilityResult } from './types.js';

export type InvokeHook = (
  name: string,
  input: Record<string, unknown>,
  context: CapabilityContext,
  result: CapabilityResult
) => void;

export class CapabilityRegistry {
  private capabilities: Map<string, CapabilityDefinition> = new Map();
  private afterInvokeHooks: InvokeHook[] = [];

  register(definition: CapabilityDefinition): void {
    if (this.capabilities.has(definition.name)) {
      throw new Error(`Capability already registered: ${definition.name}`);
    }
    this.capabilities.set(definition.name, definition);
  }

  /**
   * Register a hook fired after every successful invoke() (regardless of which
   * caller invoked it — sidecar, AI loop, CLI). Hooks receive the result and
   * must not throw; side-effects like re-initializing an engine when a
   * preference changes belong here instead of monkey-patching invoke().
   */
  onAfterInvoke(hook: InvokeHook): void {
    this.afterInvokeHooks.push(hook);
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

  async invoke(
    name: string,
    input: Record<string, unknown>,
    context: CapabilityContext
  ): Promise<CapabilityResult> {
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

    if (result.success && this.afterInvokeHooks.length > 0) {
      for (const hook of this.afterInvokeHooks) {
        try {
          hook(name, input, context, result);
        } catch (err) {
          // A side-effect hook must never break the invoke that triggered it.
          console.error(`[CapabilityRegistry] onAfterInvoke hook error for ${name}:`, err);
        }
      }
    }

    return result;
  }

  private idempotencyCache: Map<string, { result: CapabilityResult; timestamp: number }> =
    new Map();
  private static MAX_CACHE_SIZE = 10000;
  private static CACHE_TTL_MS = 3600000;

  private validateInput(
    capability: CapabilityDefinition,
    input: Record<string, unknown>
  ): string | null {
    const schema = capability.inputSchema;
    if (!schema.properties) {
      return null;
    }

    const required = (schema.required as string[]) ?? [];
    for (const field of required) {
      if (input[field] === undefined || input[field] === null) {
        return `Missing required field: ${field}`;
      }
    }

    // Type-check each declared property present in the input. This catches
    // common shape mismatches (e.g. duration_minutes as a string, locked as
    // the string "true") before they reach the domain layer, which otherwise
    // trusts its inputs.
    for (const [field, def] of Object.entries(schema.properties)) {
      const value = input[field];
      if (value === undefined || value === null) {
        continue;
      }
      const typeError = this.checkType(field, value, def as Record<string, unknown>);
      if (typeError) {
        return typeError;
      }
    }

    return null;
  }

  private checkType(field: string, value: unknown, def: Record<string, unknown>): string | null {
    const expected = def.type as string | undefined;
    if (!expected) {
      return null;
    }
    switch (expected) {
      case 'string':
        if (typeof value !== 'string') {
          return `Field "${field}" must be a string, got ${typeof value}`;
        }
        break;
      case 'number':
        if (typeof value !== 'number' || Number.isNaN(value)) {
          return `Field "${field}" must be a number, got ${typeof value}`;
        }
        break;
      case 'boolean':
        if (typeof value !== 'boolean') {
          return `Field "${field}" must be a boolean, got ${typeof value}`;
        }
        break;
      case 'array': {
        if (!Array.isArray(value)) {
          return `Field "${field}" must be an array, got ${typeof value}`;
        }
        const itemDef = def.items as Record<string, unknown> | undefined;
        if (itemDef) {
          for (let i = 0; i < value.length; i++) {
            const err = this.checkType(`${field}[${i}]`, value[i], itemDef);
            if (err) {
              return err;
            }
          }
        }
        break;
      }
      case 'object':
        if (typeof value !== 'object' || Array.isArray(value)) {
          return `Field "${field}" must be an object, got ${Array.isArray(value) ? 'array' : typeof value}`;
        }
        break;
      default:
        // Unknown schema type — do not reject; let the handler decide.
        break;
    }
    return null;
  }

  private checkIdempotency(key: string): CapabilityResult | null {
    const entry = this.idempotencyCache.get(key);
    if (!entry) {
      return null;
    }
    if (Date.now() - entry.timestamp > CapabilityRegistry.CACHE_TTL_MS) {
      this.idempotencyCache.delete(key);
      return null;
    }
    return entry.result;
  }

  private cacheIdempotency(key: string, result: CapabilityResult): void {
    if (this.idempotencyCache.size >= CapabilityRegistry.MAX_CACHE_SIZE) {
      const oldestKey = this.idempotencyCache.keys().next().value;
      if (oldestKey) {
        this.idempotencyCache.delete(oldestKey);
      }
    }
    this.idempotencyCache.set(key, { result, timestamp: Date.now() });
  }
}
