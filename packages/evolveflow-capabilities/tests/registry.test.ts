import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EvolveFlowDatabase } from '@evolveflow/storage';
import { createRegistry } from '../src/capabilities.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('Capability Registry', () => {
  let db: EvolveFlowDatabase;
  let tmpDir: string;
  let workspaceTmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-test-'));
    workspaceTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-workspace-test-'));
    process.env.EVOLVEFLOW_WORKSPACE_ROOT = workspaceTmpDir;
    db = new EvolveFlowDatabase(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(workspaceTmpDir, { recursive: true, force: true });
    delete process.env.EVOLVEFLOW_WORKSPACE_ROOT;
  });

  it('should register the production capability surface', () => {
    const registry = createRegistry(db);
    const caps = registry.list();

    expect(caps.map((cap) => cap.name).sort()).toEqual([
      'ai.cancel_stream',
      'ai.chat',
      'ai.check_connectivity',
      'ai.delete_session',
      'ai.get_context',
      'ai.stream',
      'api_key.status',
      'backup.create',
      'backup.delete',
      'backup.list',
      'backup.restore',
      'backup.verify',
      'buddy.comment',
      'buddy.greet',
      'dream.get_insights',
      'dream.run',
      'dream.status',
      'event.create',
      'event.delete',
      'event.find_conflicts',
      'event.list',
      'event.lock',
      'event.update',
      'file.list',
      'file.read',
      'file.search',
      'file.write',
      'history.list_actions',
      'memory.clear_ai_history',
      'memory.clear_learned_state',
      'preference.get',
      'preference.set',
      'reminder.list',
      'reminder.snooze',
      'schedule.analyze_quality',
      'schedule.clear_day',
      'schedule.explain',
      'schedule.get_blocks',
      'schedule.plan_day',
      'schedule.plan_range',
      'schedule.rebalance',
      'summary.generate_daily',
      'task.cancel',
      'task.complete',
      'task.create',
      'task.defer',
      'task.delete',
      'task.list',
      'task.lock',
      'task.update',
      'terminal.run',
      'undo.revert_action',
    ]);
  });

  it('should invoke task.create capability', async () => {
    const registry = createRegistry(db);
    const result = await registry.invoke(
      'task.create',
      { title: 'Test via capability' },
      { actor: 'user', origin: 'gui' }
    );

    expect(result.success).toBe(true);
    expect((result.data as Record<string, unknown>).title).toBe('Test via capability');
  });

  it('should fail when required field is missing', async () => {
    const registry = createRegistry(db);
    const result = await registry.invoke('task.create', {}, { actor: 'user', origin: 'gui' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Missing required field');
  });

  it('should fail for unknown capability', async () => {
    const registry = createRegistry(db);
    const result = await registry.invoke(
      'unknown.capability',
      {},
      { actor: 'user', origin: 'gui' }
    );

    expect(result.success).toBe(false);
  });

  it('should return cached result for idempotent calls', async () => {
    const registry = createRegistry(db);
    const ctx = { actor: 'user' as const, origin: 'gui' as const, idempotency_key: 'unique-key-1' };

    const result1 = await registry.invoke('task.create', { title: 'Idempotent task' }, ctx);
    const result2 = await registry.invoke('task.create', { title: 'Idempotent task' }, ctx);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);
  });

  it('should fire onAfterInvoke hooks after a successful invoke', async () => {
    const registry = createRegistry(db);
    const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
    registry.onAfterInvoke((name, input, _ctx, result) => {
      if (result.success) {
        calls.push({ name, input });
      }
    });

    await registry.invoke(
      'task.create',
      { title: 'Hook task' },
      {
        actor: 'user',
        origin: 'gui',
      }
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe('task.create');
    expect(calls[0].input).toEqual({ title: 'Hook task' });
  });

  it('should not break invoke when an onAfterInvoke hook throws', async () => {
    const registry = createRegistry(db);
    registry.onAfterInvoke(() => {
      throw new Error('hook boom');
    });

    // The triggering invoke must still succeed despite the hook throwing.
    const result = await registry.invoke(
      'task.create',
      { title: 'Survives hook' },
      {
        actor: 'user',
        origin: 'gui',
      }
    );
    expect(result.success).toBe(true);
  });

  it('should reject inputs whose declared types do not match the schema', async () => {
    const registry = createRegistry(db);

    // duration_minutes is declared as number; passing a string must be rejected
    // before the handler runs, instead of being silently persisted.
    const result = await registry.invoke(
      'task.create',
      { title: 'Bad duration', duration_minutes: '30' as unknown as number },
      { actor: 'user', origin: 'gui' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('duration_minutes');
  });

  it('should reject boolean fields passed as strings', async () => {
    const registry = createRegistry(db);

    const result = await registry.invoke(
      'task.lock',
      { task_id: 'does-not-exist', locked: 'true' as unknown as boolean },
      { actor: 'user', origin: 'gui' }
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('locked');
  });

  it('should increment revision after mutating call', async () => {
    const registry = createRegistry(db);
    const revBefore = db.getRevision();

    await registry.invoke(
      'task.create',
      { title: 'Revision test' },
      { actor: 'user', origin: 'gui' }
    );

    const revAfter = db.getRevision();
    expect(revAfter).toBeGreaterThan(revBefore);
  });

  it('should not change revision for non-mutating capability', async () => {
    const registry = createRegistry(db);
    await registry.invoke('task.create', { title: 'Setup' }, { actor: 'user', origin: 'gui' });

    const revBefore = db.getRevision();
    await registry.invoke('history.list_actions', {}, { actor: 'user', origin: 'gui' });
    const revAfter = db.getRevision();

    expect(revAfter).toBe(revBefore);
  });

  it('should not record api_key values in action history', async () => {
    const registry = createRegistry(db);
    const secret = 'sk-test-sensitive-value';

    const setResult = await registry.invoke(
      'preference.set',
      { key: 'api_key', value: secret },
      { actor: 'user', origin: 'gui' }
    );
    const historyResult = await registry.invoke(
      'history.list_actions',
      {},
      { actor: 'user', origin: 'gui' }
    );

    expect(setResult.success).toBe(true);
    expect(historyResult.success).toBe(true);
    expect(JSON.stringify(historyResult.data)).not.toContain(secret);
  });

  it('should provide read-only file tools and mutating file/terminal tools', async () => {
    fs.writeFileSync(
      path.join(workspaceTmpDir, 'notes.txt'),
      'database exam\ncomputer organization\n',
      'utf8'
    );
    const registry = createRegistry(db);

    const listResult = await registry.invoke(
      'file.list',
      { path: workspaceTmpDir },
      { actor: 'cli', origin: 'cli' }
    );
    const readResult = await registry.invoke(
      'file.read',
      { path: path.join(workspaceTmpDir, 'notes.txt') },
      { actor: 'cli', origin: 'cli' }
    );
    const searchResult = await registry.invoke(
      'file.search',
      { path: workspaceTmpDir, query: 'database' },
      { actor: 'cli', origin: 'cli' }
    );

    expect(registry.get('file.list')?.mutating).toBe(false);
    expect(registry.get('file.read')?.mutating).toBe(false);
    expect(registry.get('file.search')?.mutating).toBe(false);
    expect(registry.get('file.write')?.mutating).toBe(true);
    expect(registry.get('terminal.run')?.mutating).toBe(true);
    expect(listResult.success).toBe(true);
    expect(readResult.success).toBe(true);
    expect(JSON.stringify(readResult.data)).toContain('database exam');
    expect(searchResult.success).toBe(true);
    expect(JSON.stringify(searchResult.data)).toContain('notes.txt');
  });

  it('should reject file paths that only share the workspace prefix', async () => {
    const outsideDir = `${workspaceTmpDir}-outside`;
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, 'leak.txt'), 'outside workspace', 'utf8');

    try {
      const registry = createRegistry(db);
      const result = await registry.invoke(
        'file.read',
        { path: path.join(outsideDir, 'leak.txt') },
        { actor: 'cli', origin: 'cli' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('workspace');
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it('should reject backup deletion outside the backups directory', async () => {
    const outsideBackupDir = path.join(tmpDir, 'backups-other', 'evolveflow-backup-outside');
    fs.mkdirSync(outsideBackupDir, { recursive: true });

    const registry = createRegistry(db, tmpDir);
    const result = await registry.invoke(
      'backup.delete',
      { path: outsideBackupDir },
      { actor: 'cli', origin: 'cli' }
    );

    expect(result.success).toBe(false);
    expect(fs.existsSync(outsideBackupDir)).toBe(true);
  });

  it('should clear generated schedule blocks and keep protected blocks', async () => {
    const registry = createRegistry(db);
    const database = db.getDb();
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO schedule_blocks
          (id, task_id, event_id, date, start_time, end_time, locked, manual_signal, created_at, updated_at)
         VALUES
          ('generated-block', NULL, NULL, '2026-06-08', '2026-06-08T09:00:00', '2026-06-08T10:00:00', 0, 0, ?, ?),
          ('locked-block', NULL, NULL, '2026-06-08', '2026-06-08T10:00:00', '2026-06-08T11:00:00', 1, 0, ?, ?),
          ('manual-block', NULL, NULL, '2026-06-08', '2026-06-08T11:00:00', '2026-06-08T12:00:00', 0, 1, ?, ?)`
      )
      .run(now, now, now, now, now, now);

    const result = await registry.invoke(
      'schedule.clear_day',
      { date: '2026-06-08' },
      { actor: 'user', origin: 'gui' }
    );
    const remaining = database
      .prepare('SELECT id FROM schedule_blocks WHERE date = ? ORDER BY start_time')
      .all('2026-06-08') as { id: string }[];

    expect(result.success).toBe(true);
    expect((result.data as { cleared: number }).cleared).toBe(1);
    expect(remaining.map((row) => row.id)).toEqual(['locked-block', 'manual-block']);
  });

  it('should undo schedule.clear_day', async () => {
    const registry = createRegistry(db);
    const database = db.getDb();
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO schedule_blocks
          (id, task_id, event_id, date, start_time, end_time, locked, manual_signal, created_at, updated_at)
         VALUES
          ('generated-block', NULL, NULL, '2026-06-08', '2026-06-08T09:00:00', '2026-06-08T10:00:00', 0, 0, ?, ?),
          ('locked-block', NULL, NULL, '2026-06-08', '2026-06-08T10:00:00', '2026-06-08T11:00:00', 1, 0, ?, ?)`
      )
      .run(now, now, now, now);

    const clearResult = await registry.invoke(
      'schedule.clear_day',
      { date: '2026-06-08' },
      { actor: 'user', origin: 'gui' }
    );
    expect(clearResult.success).toBe(true);

    const undoResult = await registry.invoke(
      'undo.revert_action',
      { action_log_id: clearResult.action_log_id },
      { actor: 'user', origin: 'gui' }
    );
    const restored = database
      .prepare('SELECT id FROM schedule_blocks WHERE date = ? ORDER BY start_time')
      .all('2026-06-08') as { id: string }[];

    expect(undoResult.success).toBe(true);
    expect(restored.map((row) => row.id)).toEqual(['generated-block', 'locked-block']);
  });
});
