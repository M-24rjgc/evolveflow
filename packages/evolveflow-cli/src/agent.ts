import * as crypto from 'crypto';
import * as os from 'os';
import * as path from 'path';
import { EvolveFlowDatabase, ensureDataDirs } from '@evolveflow/storage';
import { createRegistry } from '@evolveflow/capabilities';
import { PreferenceService } from '@evolveflow/domain';
import {
  ApiClient,
  ApiError,
  buildConversationContext,
  capabilitiesToTools,
  DEEPSEEK_ANTHROPIC_BASE_URL,
  DEEPSEEK_MODEL,
  DEEPSEEK_PROVIDER,
  getEnvDeepSeekApiKey,
  getThinkingForMode,
  getToolListingPrompt,
  runConversation,
  type AgentMode,
  type AiStreamChunk,
  type SystemMessageParam,
  type ToolPermissionRequest,
  type ToolPermissionDecision,
} from '@evolveflow/runtime';

export { DEEPSEEK_ANTHROPIC_BASE_URL, DEEPSEEK_MODEL, DEEPSEEK_PROVIDER };
export type { AgentMode, ToolPermissionRequest };

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
  provider: typeof DEEPSEEK_PROVIDER;
  model: typeof DEEPSEEK_MODEL;
  baseUrl: typeof DEEPSEEK_ANTHROPIC_BASE_URL;
}

export interface CliPromptOptions {
  mode?: AgentMode;
  sessionId?: string;
  stream?: boolean;
  onChunk?: (chunk: AiStreamChunk) => void;
  confirmToolUse?: (
    request: ToolPermissionRequest
  ) => Promise<ToolPermissionDecision | boolean> | ToolPermissionDecision | boolean;
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
    provider: DEEPSEEK_PROVIDER,
    model: DEEPSEEK_MODEL,
    baseUrl: DEEPSEEK_ANTHROPIC_BASE_URL,
  };

  const client = apiKey
    ? new ApiClient({
        apiKey,
        maxTokens: 8192,
        timeoutMs: 120_000,
        maxRetries: 3,
      })
    : null;

  const tools = capabilitiesToTools(registry);
  const systemPrompt = buildCliSystemPrompt(registry);

  return {
    db,
    status,
    async runPrompt(prompt: string, options: CliPromptOptions = {}) {
      if (!client) {
        throw new Error(
          'DeepSeek API Key 未配置。请在桌面端设置页保存 API Key，或设置 EVOLVEFLOW_AI_KEY / DEEPSEEK_API_KEY。'
        );
      }

      const mode = options.mode || 'chat';
      const sessionId = options.sessionId || `cli_${crypto.randomUUID()}`;
      const context = await buildConversationContext(db, registry);
      const chunks: AiStreamChunk[] = [];
      let text = '';
      let error = '';

      const gen = runConversation(prompt, {
        client,
        registry,
        tools:
          mode === 'chat' || mode === 'plan'
            ? tools.filter((tool) => isReadOnlyTool(registry, tool.name))
            : tools,
        systemPrompt: [
          ...systemPrompt,
          {
            type: 'text',
            text: buildModeInstruction(mode),
          },
        ],
        context,
        sessionId,
        maxTurns: mode === 'chat' || mode === 'plan' ? 3 : undefined,
        maxTokens: mode === 'chat' ? 1800 : undefined,
        temperature: mode === 'chat' ? 0.4 : undefined,
        thinking: getThinkingForMode(mode),
        toolOrigin: 'cli',
        confirmToolUse: buildToolPermissionGuard(mode, options.confirmToolUse),
        onChunk: (chunk) => {
          chunks.push(chunk);
          if (chunk.type === 'text_delta') {
            text += chunk.content || '';
          }
          if (chunk.type === 'error') {
            error = chunk.error || error;
          }
          if (options.stream) {
            options.onChunk?.(chunk);
          }
        },
      });

      try {
        for await (const _chunk of gen) {
          // Emitted through onChunk for both collected and streaming callers.
        }
      } catch (err) {
        if (err instanceof ApiError) {
          throw new Error(`DeepSeek API 错误 [${err.status}]: ${err.message}`);
        }
        throw err;
      }

      return { sessionId, text, error: error || undefined, chunks };
    },
    async checkConnectivity() {
      if (!client) {
        return false;
      }
      return client.checkConnectivity();
    },
    close() {
      db.close();
    },
  };
}

function buildToolPermissionGuard(
  mode: AgentMode,
  confirmToolUse?: CliPromptOptions['confirmToolUse']
): CliPromptOptions['confirmToolUse'] {
  if (mode === 'yolo') {
    return () => true;
  }

  if (mode === 'auto') {
    return async (request) => {
      if (!request.mutating) {
        return true;
      }
      if (!confirmToolUse) {
        return {
          allow: false,
          reason: `Auto 模式需要确认后才能执行写入工具: ${request.capabilityName}`,
          requiresApproval: true,
        };
      }
      const decision = await confirmToolUse(request);
      if (typeof decision === 'boolean') {
        return { allow: decision, requiresApproval: true };
      }
      return { ...decision, requiresApproval: true };
    };
  }

  return undefined;
}

function buildCliSystemPrompt(registry: ReturnType<typeof createRegistry>): SystemMessageParam[] {
  return [
    {
      type: 'text',
      text: `你是 EvolveFlow 的本地 Agent，运行在终端 CLI 中。

## 固定 AI 配置
- Provider: DeepSeek
- Model: deepseek-v4-flash
- Base URL: https://api.deepseek.com/anthropic

## 工作方式
- 用简洁、直接的中文回答。
- 你可以使用工具查询和管理 EvolveFlow 的任务、日程、提醒、历史与偏好。
- 执行写入操作前，除非当前模式允许，请先说明你准备做什么。
- 不要泄露或复述 API Key。

${getToolListingPrompt(registry)}`,
    },
  ];
}

function buildModeInstruction(mode: AgentMode): string {
  switch (mode) {
    case 'plan':
      return '当前模式: Plan。你只能分析、规划和说明步骤，不要创建、更新、删除或修改任何数据。';
    case 'auto':
      return '当前模式: Auto。你可以自动执行低风险工具；对明显破坏性操作要先请求用户确认。';
    case 'yolo':
      return '当前模式: YOLO。用户已显式开启信任模式，你可以直接执行可用工具，但仍要保持结果清晰可追踪。';
    case 'chat':
    default:
      return '当前模式: Chat。优先对话和查询，只使用只读工具，不修改数据。';
  }
}

function isReadOnlyTool(registry: ReturnType<typeof createRegistry>, toolName: string): boolean {
  const capabilityName = toolName
    .replace(/__(?=.)/g, '\0')
    .replace(/_/g, '.')
    .replace(/\0/g, '_');
  const capability = registry.list().find((cap) => cap.name === capabilityName);
  return !capability?.mutating;
}
