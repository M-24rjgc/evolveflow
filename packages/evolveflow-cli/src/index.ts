#!/usr/bin/env node
import { Command } from 'commander';
import { EvolveFlowDatabase, ensureDataDirs } from '@evolveflow/storage';
import { createRegistry } from '@evolveflow/capabilities';
import * as path from 'path';
import * as os from 'os';

function getDataDir(): string {
  const base = path.join(os.homedir(), '.evolveflow', 'app-data');
  ensureDataDirs(base);
  return base;
}

function getDb(): EvolveFlowDatabase {
  const dataDir = getDataDir();
  return new EvolveFlowDatabase(path.join(dataDir, 'evolveflow.db'));
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
program.name('evolveflow').description('EvolveFlow 智能日程助手 CLI').version('0.1.0');

const jsonFlag = '--json';
const cliAiContext = { actor: 'ai' as const, origin: 'cli' as const };

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
        const result = await registry.invoke('task.create', {
          title: opts.title,
          duration_minutes: opts.duration ? parseInt(opts.duration) : undefined,
          due_date: opts.due,
          tags: opts.tags ? opts.tags.split(',') : undefined,
          project: opts.project,
        }, { actor: 'cli', origin: 'cli' });
        if (opts.json) {outputJson(result);} else {outputHuman(result.data);}
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
        const result = await registry.invoke('task.update', {
          task_id: opts.id,
          title: opts.title,
          duration_minutes: opts.duration ? parseInt(opts.duration) : undefined,
          due_date: opts.due,
          tags: opts.tags ? opts.tags.split(',') : undefined,
          project: opts.project,
        }, { actor: 'cli', origin: 'cli' });
        if (opts.json) {outputJson(result);} else {outputHuman(result.data);}
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
        const result = await registry.invoke('task.list', {
          status: opts.status,
        }, { actor: 'cli', origin: 'cli' });
        if (opts.json) {outputJson(result);} else {outputHuman(result.data);}
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
        const result = await registry.invoke('task.complete', { task_id: opts.id }, { actor: 'cli', origin: 'cli' });
        if (opts.json) {outputJson(result);} else {outputHuman(result.data);}
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
        const result = await registry.invoke('event.create', {
          title: opts.title,
          start_time: opts.start,
          end_time: opts.end,
        }, { actor: 'cli', origin: 'cli' });
        if (opts.json) {outputJson(result);} else {outputHuman(result.data);}
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
        const result = await registry.invoke('event.update', {
          event_id: opts.id,
          title: opts.title,
          start_time: opts.start,
          end_time: opts.end,
        }, { actor: 'cli', origin: 'cli' });
        if (opts.json) {outputJson(result);} else {outputHuman(result.data);}
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
          result = await registry.invoke('schedule.plan_range', {
            start_date: opts.rangeStart,
            end_date: opts.rangeEnd,
          }, { actor: 'cli', origin: 'cli' });
        } else {
          result = await registry.invoke('schedule.plan_day', {
            date: opts.date ?? new Date().toISOString().split('T')[0],
          }, { actor: 'cli', origin: 'cli' });
        }
        if (opts.json) {outputJson(result);} else {outputHuman(result.data);}
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
    const result = await registry.invoke('history.list_actions', {
      limit: parseInt(opts.limit),
    }, { actor: 'cli', origin: 'cli' });
    if (opts.json) {outputJson(result);} else {outputHuman(result.data);}
    db.close();
  });

program
  .command('ai')
  .description('与 AI 对话（受限模式）')
  .argument('<message>', '消息内容')
  .option(jsonFlag, 'JSON 输出', false)
  .action(async (message: string, opts) => {
    const db = getDb();
    const registry = createRegistry(db);

    const lower = message.toLowerCase();
    let result;

    try {
      if (lower.includes('创建任务') || lower.includes('添加任务') || lower.includes('新建任务')) {
        const titleMatch = message.match(/(?:创建|添加|新建)(?:任务|一个任务)[：:]?\s*(.+)/);
        const title = titleMatch ? titleMatch[1].trim() : message;
        result = await registry.invoke('task.create', { title }, cliAiContext);
      } else if (lower.includes('查看任务') || lower.includes('任务列表') || lower.includes('所有任务')) {
        result = await registry.invoke('task.list', {}, cliAiContext);
      } else if (lower.includes('排程') || lower.includes('安排')) {
        result = await registry.invoke('schedule.plan_day', { date: new Date().toISOString().split('T')[0] }, cliAiContext);
      } else if (lower.includes('历史') || lower.includes('记录')) {
        result = await registry.invoke('history.list_actions', { limit: 20 }, cliAiContext);
      } else {
        result = { success: false, message: '无法理解该命令。支持的操作：创建任务、查看任务、排程、查看历史记录' };
      }

      if (opts.json) {outputJson(result);}
      else {
        if (result.success) {
          outputHuman(result.data || result);
        } else {
          console.log((result as { message?: string }).message || '命令执行失败');
        }
      }
    } catch (err) {
      console.error('AI command error:', err);
      if (!opts.json) {console.log('执行 AI 命令时出错，请稍后重试');}
    }

    db.close();
  });

program.parse();
