/**
 * ai.test.ts — 精简版。
 *
 * 旧测试（ApiClient/runConversation/tools/compaction）随 loop/client/tools 删除而移除——
 * 那些代码已被 pi Agent 路径取代。
 * 保留对 buildConversationContext（context.ts，未删）的覆盖。
 * 其余 AI 能力由 harness-manager.test / native-tools.test / event-mapper（在 harness-manager.test 里）/ e2e 覆盖。
 */
import { describe, it, expect } from 'vitest';
import { buildConversationContext } from '../src/ai/context.js';
import { EvolveFlowDatabase } from '@evolveflow/storage';
import { createRegistry } from '@evolveflow/capabilities';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

function makeDb(): EvolveFlowDatabase {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-ai-test-'));
  return new EvolveFlowDatabase(path.join(dir, 'test.db'));
}

describe('buildConversationContext（保留：context.ts 未删）', () => {
  it('空库返回合法的 ConversationContext 结构', async () => {
    const db = makeDb();
    const registry = createRegistry(db, os.tmpdir());
    const ctx = await buildConversationContext(db, registry);
    expect(ctx).toBeDefined();
    expect(typeof ctx.currentDate).toBe('string');
    expect(ctx.workHours).toHaveProperty('start');
    expect(ctx.workHours).toHaveProperty('end');
    expect(Array.isArray(ctx.todayTasks)).toBe(true);
    expect(Array.isArray(ctx.todayEvents)).toBe(true);
    expect(Array.isArray(ctx.dreamInsights)).toBe(true);
    db.close();
  });

  it('work hours 默认值合理', async () => {
    const db = makeDb();
    const registry = createRegistry(db, os.tmpdir());
    const ctx = await buildConversationContext(db, registry);
    expect(ctx.workHours.start).toMatch(/^\d{2}:\d{2}$/);
    expect(ctx.workHours.end).toMatch(/^\d{2}:\d{2}$/);
    db.close();
  });

  it('加载真实任务进 todayTasks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ef-ai-test-data-'));
    const db = new EvolveFlowDatabase(path.join(dir, 'test.db'));
    try {
      const database = db.getDb();
      const localNow = new Date();
      const today = [
        localNow.getFullYear(),
        String(localNow.getMonth() + 1).padStart(2, '0'),
        String(localNow.getDate()).padStart(2, '0'),
      ].join('-');
      const now = new Date().toISOString();
      database
        .prepare(
          `INSERT INTO tasks (id, title, duration_minutes, due_date, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run('t1', 'Focus work', 60, today, now, now);

      const ctx = await buildConversationContext(db, createRegistry(db, dir));
      expect(ctx.todayTasks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: 't1', title: 'Focus work', estimatedMinutes: 60 }),
        ])
      );
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
