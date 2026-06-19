/**
 * DeepSeek Messages API HTTP client.
 * Uses native fetch() + ReadableStream for SSE streaming.
 * Zero SDK dependency — completely self-contained.
 *
 * Supports:
 *  - DeepSeek Anthropic-compatible endpoint (https://api.deepseek.com/anthropic)
 *  - Fixed model: deepseek-v4-flash
 *
 * Features:
 *  - Streaming SSE parse with backpressure handling
 *  - Retry with exponential backoff (429, 5xx)
 *  - Request timeout management
 *  - API key validation
 *  - Error classification and structured error propagation
 *  - DeepSeek-compatible thinking and tool-call configuration
 */

import type {
  CreateMessageParams,
  CreateMessageResponse,
  StreamEvent,
  AnthropicTool,
  MessageParam,
  SystemMessageParam,
  UsageInfo,
} from './types.js';
import { DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_MODEL } from './deepseek.js';

export const DEFAULT_DEEPSEEK_MODEL = DEEPSEEK_MODEL;
const DEFAULT_MAX_TOKENS = 8192;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const RETRY_MAX_DELAY_MS = 30_000;
const MAX_CONSECUTIVE_SSE_FAILURES = 10;

export interface ClientConfig {
  apiKey: string;
  /** @deprecated EvolveFlow always uses the official DeepSeek Anthropic-compatible endpoint. */
  baseUrl?: string;
  /** @deprecated EvolveFlow always uses deepseek-v4-flash. */
  model?: string;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  /** @deprecated EvolveFlow only supports DeepSeek. */
  provider?: 'anthropic' | 'deepseek';
}

export interface ClientResult {
  response: CreateMessageResponse;
  usage: UsageInfo;
}

export class ApiError extends Error {
  public readonly status: number;
  public readonly code: string;
  public readonly retryable: boolean;

  constructor(status: number, code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

export class ApiClient {
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  private maxTokens: number;
  private timeoutMs: number;
  private maxRetries: number;

  constructor(config: ClientConfig) {
    this.apiKey = config.apiKey;
    this.baseUrl = DEEPSEEK_ANTHROPIC_BASE_URL;
    this.model = DEEPSEEK_MODEL;
    this.maxTokens = config.maxTokens || DEFAULT_MAX_TOKENS;
    this.timeoutMs = config.timeoutMs || DEFAULT_TIMEOUT_MS;
    this.maxRetries = config.maxRetries ?? MAX_RETRIES;
  }

  /** Public accessor for the model name being used. */
  getModel(): string {
    return this.model;
  }

  /** Get the current provider. */
  getProvider(): 'deepseek' {
    return 'deepseek';
  }

  /** Get the API base URL currently used by this client. */
  getBaseUrl(): string {
    return this.baseUrl;
  }

  /**
   * Get DeepSeek-compatible thinking configuration.
   * DeepSeek accepts thinking enabled/disabled and ignores Anthropic budget_tokens.
   */
  getThinkingConfig(_budgetTokens: number = 2000): { type: 'enabled' } | { type: 'disabled' } {
    return { type: 'enabled' };
  }

  /** Send a non-streaming message. Returns complete response. */
  async createMessage(
    messages: MessageParam[],
    tools?: AnthropicTool[],
    systemPrompt?: string | SystemMessageParam[],
    options?: {
      model?: string;
      maxTokens?: number;
      temperature?: number;
      toolChoice?: CreateMessageParams['tool_choice'];
      thinking?: CreateMessageParams['thinking'];
    }
  ): Promise<ClientResult> {
    const params: CreateMessageParams = {
      model: this.model,
      max_tokens: options?.maxTokens || this.maxTokens,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(options?.toolChoice
        ? { tool_choice: options.toolChoice }
        : tools?.length
          ? { tool_choice: { type: 'auto' } }
          : {}),
      ...(systemPrompt ? { system: this.normalizeSystemPrompt(systemPrompt) } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.thinking ? { thinking: options.thinking } : {}),
    };

    const response = await this.fetchWithRetry('/v1/messages', {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(params),
    });

    let data: CreateMessageResponse;
    try {
      data = JSON.parse(response);
    } catch {
      throw new ApiError(0, 'parse_error', 'Invalid JSON response from API', false);
    }
    return {
      response: data,
      usage: data.usage,
    };
  }

  /**
   * Send a streaming message.
   * Returns an async generator that yields StreamEvent objects.
   */
  async *streamMessage(
    messages: MessageParam[],
    tools?: AnthropicTool[],
    systemPrompt?: string | SystemMessageParam[],
    options?: {
      model?: string;
      maxTokens?: number;
      temperature?: number;
      toolChoice?: CreateMessageParams['tool_choice'];
      thinking?: CreateMessageParams['thinking'];
    },
    externalSignal?: AbortSignal
  ): AsyncGenerator<StreamEvent> {
    const params: CreateMessageParams = {
      model: this.model,
      max_tokens: options?.maxTokens || this.maxTokens,
      messages,
      ...(tools && tools.length > 0 ? { tools } : {}),
      ...(options?.toolChoice
        ? { tool_choice: options.toolChoice }
        : tools?.length
          ? { tool_choice: { type: 'auto' } }
          : {}),
      ...(systemPrompt ? { system: this.normalizeSystemPrompt(systemPrompt) } : {}),
      ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(options?.thinking ? { thinking: options.thinking } : {}),
      stream: true as const,
    };

    const url = `${this.baseUrl}/v1/messages`;
    const serializedBody = JSON.stringify(params);

    let attempt = 0;

    while (attempt <= this.maxRetries) {
      attempt++;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      if (externalSignal) {
        externalSignal.addEventListener('abort', onAbort, { once: true });
      }
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: this.buildHeaders(),
          body: serializedBody,
          signal: controller.signal,
        });
        clearTimeout(timeoutId);

        if (!response.ok) {
          const errorBody = await response.text().catch(() => '');
          const retryAfterHeader = response.headers.get('Retry-After');
          const { retryable, error, retryAfterSeconds } = this.classifyError(
            response.status,
            errorBody,
            retryAfterHeader
          );
          if (retryable && attempt <= this.maxRetries) {
            const delay = this.calculateBackoff(attempt, retryAfterSeconds);
            await this.sleep(delay);
            continue;
          }
          throw error;
        }

        if (!response.body) {
          throw new ApiError(0, 'no_body', 'Response body is empty', false);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let consecutiveSseFailures = 0;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              break;
            }

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
              const trimmed = line.trim();
              if (!trimmed) {
                continue;
              }

              // SSE format: "event: <type>" followed by "data: <json>"
              if (trimmed.startsWith('event:')) {
                continue; // event type is embedded in data for Anthropic
              }

              const dataMatch = trimmed.match(/^data:\s*(.+)$/);
              if (dataMatch) {
                const jsonStr = dataMatch[1].trim();
                if (!jsonStr) {
                  continue;
                }

                try {
                  const event: StreamEvent = JSON.parse(jsonStr);
                  yield event;
                  consecutiveSseFailures = 0;
                } catch {
                  consecutiveSseFailures++;
                  console.warn(
                    `[ApiClient] Failed to parse SSE data line (failure #${consecutiveSseFailures}): ${jsonStr.slice(0, 200)}`
                  );
                  if (consecutiveSseFailures >= MAX_CONSECUTIVE_SSE_FAILURES) {
                    throw new ApiError(
                      0,
                      'sse_parse_error',
                      `SSE parsing failed for ${MAX_CONSECUTIVE_SSE_FAILURES} consecutive data lines`,
                      false
                    );
                  }
                }
              }
            }
          }

          // Process remaining buffer using regex
          if (buffer.trim()) {
            const remainingMatch = buffer.trim().match(/^data:\s*(.+)$/);
            if (remainingMatch) {
              const jsonStr = remainingMatch[1].trim();
              if (jsonStr) {
                try {
                  const event: StreamEvent = JSON.parse(jsonStr);
                  yield event;
                } catch {
                  consecutiveSseFailures++;
                  console.warn(
                    `[ApiClient] Failed to parse remaining SSE data: ${jsonStr.slice(0, 200)}`
                  );
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }

        // Success — exit retry loop
        break;
      } catch (err) {
        clearTimeout(timeoutId);

        if (err instanceof ApiError) {
          if (err.retryable && attempt <= this.maxRetries) {
            const delay = this.calculateBackoff(attempt);
            await this.sleep(delay);
            continue;
          }
          throw err;
        }

        if (err instanceof DOMException && err.name === 'AbortError') {
          if (externalSignal?.aborted) {
            throw err;
          }
          const apiErr = new ApiError(
            408,
            'timeout',
            `Request timed out after ${this.timeoutMs}ms`,
            true
          );
          // Note: do NOT increment attempt here. The loop header already
          // advances it once per iteration; a second increment would make a
          // single timeout consume two retry slots (halving the effective
          // retry count for timeout failures).
          if (attempt <= this.maxRetries) {
            const delay = this.calculateBackoff(attempt);
            await this.sleep(delay);
            continue;
          }
          throw apiErr;
        }

        // Network errors are retryable
        if (attempt <= this.maxRetries) {
          const delay = this.calculateBackoff(attempt);
          await this.sleep(delay);
          continue;
        }

        throw new ApiError(
          0,
          'network_error',
          `Network error: ${err instanceof Error ? err.message : String(err)}`,
          true
        );
      } finally {
        if (externalSignal) {
          externalSignal.removeEventListener('abort', onAbort);
        }
      }
    }
  }

  /** Validate connectivity with a real lightweight Messages API request. */
  async checkConnectivity(): Promise<boolean> {
    try {
      await this.createMessage(
        [{ role: 'user', content: 'Reply with OK.' }],
        undefined,
        undefined,
        { maxTokens: 8, temperature: 0 }
      );
      return true;
    } catch {
      return false;
    }
  }

  // ── Private Helpers ──────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
    };
  }

  private normalizeSystemPrompt(
    systemPrompt: string | SystemMessageParam[]
  ): string | SystemMessageParam[] {
    if (typeof systemPrompt === 'string') {
      return systemPrompt;
    }

    return systemPrompt.map((block) => ({
      type: block.type,
      text: block.text,
    }));
  }

  private async fetchWithRetry(
    path: string,
    init: RequestInit,
    attempt: number = 1
  ): Promise<string> {
    const url = `${this.baseUrl}${path}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const response = await fetch(url, { ...init, signal: controller.signal });

        const body = await response.text();

        if (!response.ok) {
          const retryAfterHeader = response.headers.get('Retry-After');
          const { retryable, error, retryAfterSeconds } = this.classifyError(
            response.status,
            body,
            retryAfterHeader
          );
          if (retryable && attempt <= this.maxRetries) {
            const delay = this.calculateBackoff(attempt, retryAfterSeconds);
            await this.sleep(delay);
            return this.fetchWithRetry(path, init, attempt + 1);
          }
          throw error;
        }

        return body;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        throw err;
      }
      if (attempt <= this.maxRetries) {
        const delay = this.calculateBackoff(attempt);
        await this.sleep(delay);
        return this.fetchWithRetry(path, init, attempt + 1);
      }
      throw err;
    }
  }

  private classifyError(
    status: number,
    body: string,
    retryAfterHeader?: string | null
  ): { retryable: boolean; error: ApiError; retryAfterSeconds: number | null } {
    let code = 'unknown';
    let message = body;

    try {
      const parsed = JSON.parse(body);
      if (parsed.error) {
        code = parsed.error.type || code;
        message = parsed.error.message || message;
      }
    } catch {
      // body is not JSON
    }

    const retryable =
      status === 429 ||
      status >= 500 ||
      status === 408 ||
      code === 'overloaded_error' ||
      code === 'rate_limit_error';

    let retryAfterSeconds: number | null = null;
    if (status === 429 && retryAfterHeader) {
      const parsed = parseInt(retryAfterHeader, 10);
      if (!isNaN(parsed) && parsed > 0) {
        retryAfterSeconds = parsed;
      }
    }

    return {
      retryable,
      error: new ApiError(status, code, message, retryable),
      retryAfterSeconds,
    };
  }

  private calculateBackoff(attempt: number, retryAfterSeconds?: number | null): number {
    if (retryAfterSeconds !== null && retryAfterSeconds !== undefined && retryAfterSeconds > 0) {
      return Math.min(retryAfterSeconds * 1000, RETRY_MAX_DELAY_MS);
    }
    const delay = RETRY_BASE_DELAY_MS * Math.pow(2, attempt - 1);
    const jitter = Math.random() * 1000;
    return Math.min(delay + jitter, RETRY_MAX_DELAY_MS);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
