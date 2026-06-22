/**
 * EvolveFlow CLI Agent（pi 包集成层）。
 *
 * 直接调 pi 包的 createEvolveFlowHarness（AI 逻辑全在 pi 内部）。
 * CLI 是开发/调试工具，复用与 sidecar 同款的 pi AgentHarness 路径。
 */
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { EvolveFlowDatabase, ensureDataDirs } from '@evolveflow/storage';
import { createRegistry } from '@evolveflow/capabilities';
import { PreferenceService } from '@evolveflow/domain';
import {
  createEvolveFlowHarness,
  resolveEvolveFlowMode,
  type EvolveFlowAgentMode,
  type EvolveFlowChunk,
  type EvolveFlowContext,
} from '@evolveflow/vendor-pi-agent';
import type { AgentHarness } from '@evolveflow/vendor-pi-agent';
import { capabilitiesToAgentTools } from '@evolveflow/pi-bridge';
import { buildConversationContext } from '@evolveflow/runtime';
import { getEnvDeepSeekApiKey } from '@evolveflow/runtime';

export type { EvolveFlowAgentMode as AgentMode };

export interface CliAgent {
  db: EvolveFlowDatabase;
  status: CliAgentStatus;
  runPrompt(prompt: string, options?: CliPromptOptions): Promise<CliPromptResult>;
  checkConnectivity(): Promise<boolean>;
  close(): void;
}

export interface CliAgentStatus {
  configured: boolean;
  keySource: 'stored' | 'environment' | 'none';
  keySuffix: string;
  provider: 'DeepSeek';
  model: 'deepseek-v4-pro';
  baseUrl: 'https://api.deepseek.com';
}

export interface CliPromptOptions {
  mode?: EvolveFlowAgentMode;
  sessionId?: string;
  stream?: boolean;
  onChunk?: (chunk: EvolveFlowChunk) => void;
}

export interface CliPromptResult {
  sessionId: string;
  text: string;
  error?: string;
  chunks: EvolveFlowChunk[];
}

export function getDataDir(): string {
  const base = path.join(os.homedir(), '.evolveflow', 'app-data');
  ensureDataDirs(base);
  return base;
}

export function getDb(): EvolveFlowDatabase {
  const dataDir = getDataDir();
  return new EvolveFlowDatabase(path.join(dataDir, 'evolveflow.db'));
}

/** CLI 简化的上下文（空数据库则返回最小可用上下文）。 */
async function buildCliContext(
  db: EvolveFlowDatabase,
  registry: ReturnType<typeof createRegistry>
): Promise<EvolveFlowContext> {
  const ctx = await buildConversationContext(db, registry);
  return ctx as unknown as EvolveFlowContext;
}

export function createCliAgent(): CliAgent {
  const db = getDb();
  const registry = createRegistry(db);
  const preferenceService = new PreferenceService(db.getDb());
  const storedKey = preferenceService.get('api_key') || '';
  const envKey = getEnvDeepSeekApiKey();
  const apiKey = storedKey || envKey;

  const status: CliAgentStatus = {
    configured: !!apiKey,
    keySource: storedKey ? 'stored' : envKey ? 'environment' : 'none',
    keySuffix: apiKey ? apiKey.slice(-4) : '',
    provider: 'DeepSeek',
    model: 'deepseek-v4-pro',
    baseUrl: 'https://api.deepseek.com',
  };

  const harnesses = new Map<string, AgentHarness>();

  async function getHarness(sessionId: string, mode: EvolveFlowAgentMode): Promise<AgentHarness> {
    if (harnesses.has(sessionId)) {
      return harnesses.get(sessionId)!;
    }
    if (!apiKey) {
      throw new Error(
        'DeepSeek API Key 未配置。请在桌面端设置页保存 API Key，或设置 EVOLVEFLOW_AI_KEY / DEEPSEEK_API_KEY。'
      );
    }
    const context = await buildCliContext(db, registry);
    const capabilityTools = capabilitiesToAgentTools(registry, {
      actor: 'ai',
      origin: 'cli',
      session_id: sessionId,
    });
    const harness = await createEvolveFlowHarness({
      apiKey,
      capabilityTools,
      mode,
      sessionId,
      context,
    });
    harnesses.set(sessionId, harness);
    return harness;
  }

  return {
    db,
    status,
    async runPrompt(prompt: string, options: CliPromptOptions = {}) {
      const mode = resolveEvolveFlowMode(options.mode, 'chat');
      const sessionId = options.sessionId || `cli_${crypto.randomUUID()}`;
      const chunks: EvolveFlowChunk[] = [];

      let text = '';
      let error = '';
      try {
        // 为收集 chunk 重建 harness（带 onEvent）。
        const context = await buildCliContext(db, registry);
        const capabilityTools = capabilitiesToAgentTools(registry, {
          actor: 'ai',
          origin: 'cli',
          session_id: sessionId,
        });
        const harness = await createEvolveFlowHarness({
          apiKey: apiKey!,
          capabilityTools,
          mode,
          sessionId,
          context,
          onEvent: (chunk) => {
            chunks.push(chunk);
            if (options.stream) {
              options.onChunk?.(chunk);
            }
          },
        });
        const assistantMsg = await harness.prompt(prompt);
        text = (assistantMsg.content ?? [])
          .filter((c) => c.type === 'text')
          .map((c) => ('text' in c ? c.text : ''))
          .join('');
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      return { sessionId, text, error: error || undefined, chunks };
    },
    async checkConnectivity() {
      if (!apiKey) {
        return false;
      }
      try {
        const harness = await getHarness(`conn_${crypto.randomUUID()}`, 'chat');
        await harness.prompt('ping');
        return true;
      } catch {
        return false;
      }
    },
    close() {
      for (const h of harnesses.values()) {
        void h.abort().catch(() => {});
      }
      harnesses.clear();
      db.close();
    },
  };
}
