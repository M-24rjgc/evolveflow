#!/usr/bin/env node
import { Command } from 'commander';
import { EvolveFlowDatabase, ensureDataDirs } from '@evolveflow/storage';
import { createRegistry } from '@evolveflow/capabilities';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { createCliAgent, type AgentMode } from './agent.js';

const DEEPSEEK_PROVIDER = 'DeepSeek' as const;
const DEEPSEEK_MODEL = 'deepseek-v4-pro' as const;
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com' as const;

function getDataDir(): string {
  const base = path.join(os.homedir(), '.evolveflow', 'app-data');
  ensureDataDirs(base);
  return base;
}

function getDb(): EvolveFlowDatabase {
  const dataDir = getDataDir();
  return new EvolveFlowDatabase(path.join(dataDir, 'evolveflow.db'));
}

function localDateString(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function outputJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function outputHuman(data: unknown): void {
  if (Array.isArray(data)) {
    for (const item of data) {
      if (typeof item === 'object' && item !== null) {
        const obj = item as Record<string, unknown>;
        console.log(`  - ${obj.title ?? obj.name ?? obj.id ?? JSON.stringify(item)}`);
      } else {
        console.log(`  - ${item}`);
      }
    }
  } else if (typeof data === 'object' && data !== null) {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

const program = new Command();
program
  .name('evolveflow')
  .description('EvolveFlow 本地 Agent CLI')
  .version('0.1.0')
  .option('-p, --prompt <message>', '单次向 DeepSeek-V4-Flash Agent 提问')
  .option('--mode <mode>', 'Agent 模式: chat | plan | auto | yolo', 'chat')
  .hook('preAction', (thisCommand, actionCommand) => {
    if (actionCommand.name() === thisCommand.name()) {
      return;
    }
  });

const jsonFlag = '--json';

const VALID_AGENT_MODES = new Set<AgentMode>(['chat', 'plan', 'auto', 'yolo']);

function parseAgentMode(value: unknown): AgentMode {
  const mode = String(value || 'chat').toLowerCase() as AgentMode;
  return VALID_AGENT_MODES.has(mode) ? mode : 'chat';
}

function printAgentHeader(mode: AgentMode): void {
  console.log(`EvolveFlow Agent`);
  console.log(`Provider: ${DEEPSEEK_PROVIDER}`);
  console.log(`Model: ${DEEPSEEK_MODEL}`);
  console.log(`Mode: ${formatMode(mode)}`);
  console.log(`Base URL: ${DEEPSEEK_BASE_URL}`);
}

function formatMode(mode: AgentMode): string {
  return mode === 'yolo' ? 'YOLO' : mode.charAt(0).toUpperCase() + mode.slice(1);
}

function printHelp(): void {
  console.log(
    [
      '命令:',
      '  /status        查看 DeepSeek 连接与模型状态',
      '  /connect       显示 API Key 配置方式',
      '  /mode <mode>   切换模式: chat | plan | auto | yolo',
      '  /clear         清屏并开始新会话',
      '  /help          查看帮助',
      '  /exit          退出',
    ].join('\n')
  );
}

function printConnectHelp(): void {
  console.log(
    [
      'DeepSeek 连接配置:',
      '  1. 桌面端: 设置 -> AI 配置 -> 保存 DeepSeek API Key',
      '  2. 终端环境变量: EVOLVEFLOW_AI_KEY 或 DEEPSEEK_API_KEY',
      `  固定 Provider: ${DEEPSEEK_PROVIDER}`,
      `  固定 Model: ${DEEPSEEK_MODEL}`,
      `  固定 Base URL: ${DEEPSEEK_BASE_URL}`,
    ].join('\n')
  );
}

async function runPromptOnce(message: string, mode: AgentMode): Promise<void> {
  const agent = createCliAgent();
  try {
    if (!agent.status.configured) {
      console.error(
        'DeepSeek API Key 未配置。请设置 EVOLVEFLOW_AI_KEY / DEEPSEEK_API_KEY，或在桌面端设置页保存 API Key。'
      );
      process.exitCode = 1;
      return;
    }

    const result = await agent.runPrompt(message, { mode });
    if (result.text.trim()) {
      console.log(result.text.trim());
    }
    if (result.error) {
      console.error(result.error);
      process.exitCode = 1;
    }
  } finally {
    agent.close();
  }
}

async function runInteractive(initialMode: AgentMode): Promise<void> {
  const agent = createCliAgent();
  let mode = initialMode;
  let sessionId = `cli_${Date.now()}`;
  const pendingPrompt = false;

  try {
    printAgentHeader(mode);
    if (!agent.status.configured) {
      console.log(
        'DeepSeek API Key 未配置。请设置 EVOLVEFLOW_AI_KEY / DEEPSEEK_API_KEY，或在桌面端设置页保存 API Key。'
      );
    } else {
      console.log(
        `API Key: ${agent.status.keySource}${agent.status.keySuffix ? ` (...${agent.status.keySuffix})` : ''}`
      );
    }
    printHelp();

    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: `\n${formatMode(mode)} > `,
    });

    const ask = () => rl.prompt();
    let lineQueue = Promise.resolve();
    ask();

    rl.on('line', (line) => {
      const input = line.trim();
      lineQueue = lineQueue
        .then(async () => {
          if (!input) {
            ask();
            return;
          }

          if (input === '/exit' || input === '/quit') {
            rl.close();
            return;
          }

          if (input === '/help') {
            printHelp();
            ask();
            return;
          }

          if (input === '/connect') {
            printConnectHelp();
            ask();
            return;
          }

          if (input === '/clear') {
            console.clear();
            sessionId = `cli_${Date.now()}`;
            printAgentHeader(mode);
            ask();
            return;
          }

          if (input === '/status') {
            console.log(`Provider: ${DEEPSEEK_PROVIDER}`);
            console.log(`Model: ${DEEPSEEK_MODEL}`);
            console.log(`Mode: ${formatMode(mode)}`);
            console.log(`Base URL: ${DEEPSEEK_BASE_URL}`);
            console.log(
              `API Key: ${agent.status.configured ? `${agent.status.keySource} (...${agent.status.keySuffix})` : 'not configured'}`
            );
            if (agent.status.configured) {
              const connected = await agent.checkConnectivity();
              console.log(`Connection: ${connected ? 'ok' : 'failed'}`);
            }
            ask();
            return;
          }

          if (input.startsWith('/mode')) {
            const nextMode = parseAgentMode(input.split(/\s+/)[1]);
            mode = nextMode;
            console.log(`Mode: ${formatMode(mode)}`);
            if (mode === 'yolo') {
              console.log('YOLO 模式已显式开启：写入工具和终端工具将不再逐项确认。');
            }
            ask();
            return;
          }

          if (!agent.status.configured) {
            console.log('DeepSeek API Key 未配置，无法发起 AI 请求。');
            ask();
            return;
          }

          let wroteText = false;
          try {
            const result = await agent.runPrompt(input, {
              mode,
              sessionId,
              stream: true,
              onChunk: (chunk) => {
                if (chunk.type === 'text_delta' && chunk.content) {
                  process.stdout.write(chunk.content);
                  wroteText = true;
                } else if (chunk.type === 'tool_use_start') {
                  process.stdout.write(`\n[tool] ${chunk.tool_name}\n`);
                } else if (chunk.type === 'tool_permission_request' && mode === 'auto') {
                  process.stdout.write(
                    `\n[approval] ${chunk.capability_name || chunk.tool_name}\n`
                  );
                } else if (chunk.type === 'tool_result') {
                  process.stdout.write(`[tool done] ${chunk.tool_name || chunk.tool_use_id}\n`);
                }
              },
            });

            if (!wroteText && result.text.trim()) {
              process.stdout.write(result.text.trim());
            }
            if (result.error) {
              process.stdout.write(`\n${result.error}`);
            }
            process.stdout.write('\n');
          } catch (err) {
            console.error(err instanceof Error ? err.message : String(err));
          }
          if (!pendingPrompt) {
            ask();
          }
        })
        .catch((err) => {
          console.error(err instanceof Error ? err.message : String(err));
          ask();
        });
    });

    await new Promise<void>((resolve) => {
      rl.on('close', resolve);
    });
  } finally {
    agent.close();
  }
}

program
  .command('task')
  .description('任务管理')
  .addCommand(
    new Command('create')
      .description('创建任务')
      .requiredOption('-t, --title <title>', '任务标题')
      .option('-d, --duration <minutes>', '时长（分钟）')
      .option('--due <date>', '截止日期')
      .option('--tags <tags>', '标签（逗号分隔）')
      .option('--project <project>', '项目')
      .option(jsonFlag, 'JSON 输出', false)
      .action(async (opts) => {
        const db = getDb();
        const registry = createRegistry(db);
        const result = await registry.invoke(
          'task.create',
          {
            title: opts.title,
            duration_minutes: opts.duration ? parseInt(opts.duration) : undefined,
            due_date: opts.due,
            tags: opts.tags ? opts.tags.split(',') : undefined,
            project: opts.project,
          },
          { actor: 'cli', origin: 'cli' }
        );
        if (opts.json) {
          outputJson(result);
        } else {
          outputHuman(result.data);
        }
        db.close();
      })
  )
  .addCommand(
    new Command('update')
      .description('更新任务')
      .requiredOption('--id <taskId>', '任务 ID')
      .option('-t, --title <title>', '新标题')
      .option('-d, --duration <minutes>', '时长（分钟）')
      .option('--due <date>', '截止日期')
      .option('--tags <tags>', '标签（逗号分隔）')
      .option('--project <project>', '项目')
      .option(jsonFlag, 'JSON 输出', false)
      .action(async (opts) => {
        const db = getDb();
        const registry = createRegistry(db);
        const result = await registry.invoke(
          'task.update',
          {
            task_id: opts.id,
            title: opts.title,
            duration_minutes: opts.duration ? parseInt(opts.duration) : undefined,
            due_date: opts.due,
            tags: opts.tags ? opts.tags.split(',') : undefined,
            project: opts.project,
          },
          { actor: 'cli', origin: 'cli' }
        );
        if (opts.json) {
          outputJson(result);
        } else {
          outputHuman(result.data);
        }
        db.close();
      })
  )
  .addCommand(
    new Command('list')
      .description('列出任务')
      .option('--status <status>', '状态筛选')
      .option(jsonFlag, 'JSON 输出', false)
      .action(async (opts) => {
        const db = getDb();
        const registry = createRegistry(db);
        const result = await registry.invoke(
          'task.list',
          {
            status: opts.status,
          },
          { actor: 'cli', origin: 'cli' }
        );
        if (opts.json) {
          outputJson(result);
        } else {
          outputHuman(result.data);
        }
        db.close();
      })
  )
  .addCommand(
    new Command('complete')
      .description('完成任务')
      .requiredOption('--id <taskId>', '任务 ID')
      .option(jsonFlag, 'JSON 输出', false)
      .action(async (opts) => {
        const db = getDb();
        const registry = createRegistry(db);
        const result = await registry.invoke(
          'task.complete',
          { task_id: opts.id },
          { actor: 'cli', origin: 'cli' }
        );
        if (opts.json) {
          outputJson(result);
        } else {
          outputHuman(result.data);
        }
        db.close();
      })
  );

program
  .command('event')
  .description('事件管理')
  .addCommand(
    new Command('create')
      .description('创建事件')
      .requiredOption('-t, --title <title>', '事件标题')
      .requiredOption('-s, --start <startTime>', '开始时间')
      .requiredOption('-e, --end <endTime>', '结束时间')
      .option(jsonFlag, 'JSON 输出', false)
      .action(async (opts) => {
        const db = getDb();
        const registry = createRegistry(db);
        const result = await registry.invoke(
          'event.create',
          {
            title: opts.title,
            start_time: opts.start,
            end_time: opts.end,
          },
          { actor: 'cli', origin: 'cli' }
        );
        if (opts.json) {
          outputJson(result);
        } else {
          outputHuman(result.data);
        }
        db.close();
      })
  )
  .addCommand(
    new Command('update')
      .description('更新事件')
      .requiredOption('--id <eventId>', '事件 ID')
      .option('-t, --title <title>', '新标题')
      .option('-s, --start <startTime>', '开始时间')
      .option('-e, --end <endTime>', '结束时间')
      .option(jsonFlag, 'JSON 输出', false)
      .action(async (opts) => {
        const db = getDb();
        const registry = createRegistry(db);
        const result = await registry.invoke(
          'event.update',
          {
            event_id: opts.id,
            title: opts.title,
            start_time: opts.start,
            end_time: opts.end,
          },
          { actor: 'cli', origin: 'cli' }
        );
        if (opts.json) {
          outputJson(result);
        } else {
          outputHuman(result.data);
        }
        db.close();
      })
  );

program
  .command('schedule')
  .description('排程管理')
  .addCommand(
    new Command('plan')
      .description('自动排程')
      .option('--date <date>', '日期')
      .option('--range-start <startDate>', '范围开始')
      .option('--range-end <endDate>', '范围结束')
      .option(jsonFlag, 'JSON 输出', false)
      .action(async (opts) => {
        const db = getDb();
        const registry = createRegistry(db);
        let result;
        if (opts.rangeStart && opts.rangeEnd) {
          result = await registry.invoke(
            'schedule.plan_range',
            {
              start_date: opts.rangeStart,
              end_date: opts.rangeEnd,
            },
            { actor: 'cli', origin: 'cli' }
          );
        } else {
          result = await registry.invoke(
            'schedule.plan_day',
            {
              date: opts.date ?? localDateString(),
            },
            { actor: 'cli', origin: 'cli' }
          );
        }
        if (opts.json) {
          outputJson(result);
        } else {
          outputHuman(result.data);
        }
        db.close();
      })
  )
  .addCommand(
    new Command('clear')
      .description('Clear generated schedule blocks for a date')
      .option('--date <date>', 'Date, defaults to today')
      .option(jsonFlag, 'JSON output', false)
      .action(async (opts) => {
        const db = getDb();
        const registry = createRegistry(db);
        const date = opts.date ?? localDateString();
        const result = await registry.invoke(
          'schedule.clear_day',
          { date },
          { actor: 'cli', origin: 'cli' }
        );
        if (opts.json) {
          outputJson(result);
        } else if (result.success) {
          const data = result.data as { cleared?: number; date?: string } | undefined;
          console.log(
            `Cleared ${data?.cleared ?? 0} generated schedule block(s) for ${data?.date ?? date}.`
          );
        } else {
          console.error(result.error ?? 'Failed to clear schedule.');
          process.exitCode = 1;
        }
        db.close();
      })
  );

program
  .command('history')
  .description('查看动作记录')
  .option('--limit <limit>', '数量限制', '20')
  .option(jsonFlag, 'JSON 输出', false)
  .action(async (opts) => {
    const db = getDb();
    const registry = createRegistry(db);
    const result = await registry.invoke(
      'history.list_actions',
      {
        limit: parseInt(opts.limit),
      },
      { actor: 'cli', origin: 'cli' }
    );
    if (opts.json) {
      outputJson(result);
    } else {
      outputHuman(result.data);
    }
    db.close();
  });

program
  .command('ai')
  .description('与 DeepSeek-V4-Flash Agent 对话')
  .argument('<message>', '消息内容')
  .option('--mode <mode>', 'Agent 模式: chat | plan | auto | yolo', 'chat')
  .option(jsonFlag, 'JSON 输出', false)
  .action(async (message: string, opts) => {
    const mode = parseAgentMode(opts.mode);
    if (opts.json) {
      const agent = createCliAgent();
      try {
        const result = await agent.runPrompt(message, { mode });
        outputJson({
          provider: DEEPSEEK_PROVIDER,
          model: DEEPSEEK_MODEL,
          mode,
          ...result,
        });
      } finally {
        agent.close();
      }
      return;
    }
    await runPromptOnce(message, mode);
  });

program.action(async (opts) => {
  const mode = parseAgentMode(opts.mode);
  if (opts.prompt) {
    await runPromptOnce(opts.prompt, mode);
    return;
  }
  await runInteractive(mode);
});

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
