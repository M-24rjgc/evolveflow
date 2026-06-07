import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EvolveFlowDatabase } from '@evolveflow/storage';
import { createRegistry } from '../src/capabilities.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('Capability Registry', () => {
  let db: EvolveFlowDatabase;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-test-'));
    db = new EvolveFlowDatabase(path.join(tmpDir, 'test.db'));
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
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
      'history.list_actions',
      'memory.clear_ai_history',
      'memory.clear_learned_state',
      'preference.get',
      'preference.set',
      'reminder.list',
      'reminder.snooze',
      'schedule.analyze_quality',
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
      'undo.revert_action',
    ]);
  });

  it('should invoke task.create capability', async () => {
    const registry = createRegistry(db);
    const result = await registry.invoke('task.create', { title: 'Test via capability' }, { actor: 'user', origin: 'gui' });

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
    const result = await registry.invoke('unknown.capability', {}, { actor: 'user', origin: 'gui' });

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

  it('should increment revision after mutating call', async () => {
    const registry = createRegistry(db);
    const revBefore = db.getRevision();

    await registry.invoke('task.create', { title: 'Revision test' }, { actor: 'user', origin: 'gui' });

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
});
