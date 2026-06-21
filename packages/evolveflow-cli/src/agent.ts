/**
 * EvolveFlow CLI Agent（pi 路径版）。
 *
 * 经 runtime 的 HarnessManager（pi Agent）跑对话，替代旧的 ApiClient + runConversation。
 * CLI 是开发/调试工具，复用 sidecar 同款 AI 路径。
 */
import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { EvolveFlowDatabase, ensureDataDirs } from '@evolveflow/storage';
import { createRegistry } from '@evolveflow/capabilities';
import { PreferenceService } from '@evolveflow/domain';
import {
  HarnessManager,
  getEnvDeepSeekApiKey,
  type AgentMode,
  type AiStreamChunk,
} from '@evolveflow/runtime';

export type { AgentMode };

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
  mode?: AgentMode;
  sessionId?: string;
  stream?: boolean;
  onChunk?: (chunk: AiStreamChunk) => void;
}

export interface CliPromptResult {
  sessionId: string;
  text: string;
  error?: string;
  chunks: AiStreamChunk[];
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

  // 经 HarnessManager（pi Agent 路径）。
  const manager = apiKey
    ? new HarnessManager({
        db,
        registry,
        apiKey,
        onChunk: () => {
          /* CLI 的 onChunk 在 runPrompt 里单独收集（经 mode/sessionId） */
        },
      })
    : null;

  return {
    db,
    status,
    async runPrompt(prompt: string, options: CliPromptOptions = {}) {
      if (!manager) {
        throw new Error(
          'DeepSeek API Key 未配置。请在桌面端设置页保存 API Key，或设置 EVOLVEFLOW_AI_KEY / DEEPSEEK_API_KEY。'
        );
      }
      const mode = options.mode || 'chat';
      const sessionId = options.sessionId || `cli_${crypto.randomUUID()}`;
      const chunks: AiStreamChunk[] = [];

      // 包装一个收集 onChunk 的 manager（复用同一 registry/db/apiKey，但带收集回调）。
      const collectingManager = new HarnessManager({
        db,
        registry,
        apiKey: apiKey!,
        onChunk: (chunk) => {
          chunks.push(chunk);
          if (options.stream) {
            options.onChunk?.(chunk);
          }
        },
      });

      let text = '';
      let error = '';
      try {
        text = await collectingManager.prompt(sessionId, mode, prompt, {
          actor: 'ai',
          origin: 'cli',
          session_id: sessionId,
        });
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      }
      await collectingManager.disposeAll();
      return { sessionId, text, error: error || undefined, chunks };
    },
    async checkConnectivity() {
      if (!manager) {
        return false;
      }
      try {
        await manager.prompt(`conn_${crypto.randomUUID()}`, 'chat', 'ping', {
          actor: 'ai',
          origin: 'cli',
          session_id: 'conn',
        });
        return true;
      } catch {
        return false;
      }
    },
    close() {
      void manager?.disposeAll();
      db.close();
    },
  };
}
