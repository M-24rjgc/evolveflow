import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync, copyFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EvolveFlowDatabase, ensureDataDirs } from '../src/database.js';
import { BackupService } from '../src/backup.js';

describe('EvolveFlowDatabase', () => {
  let tmpDir: string;
  let db: EvolveFlowDatabase;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'evolveflow-storage-test-'));
  });

  afterAll(() => {
    if (db) {
      db.close();
    }
  });

  it('should create a database and initialize schema', () => {
    const dbPath = join(tmpDir, 'test.db');
    db = new EvolveFlowDatabase(dbPath);
    expect(db).toBeInstanceOf(EvolveFlowDatabase);
    expect(existsSync(dbPath)).toBe(true);
  });

  it('should return the underlying database instance', () => {
    const sqliteDb = db.getDb();
    expect(sqliteDb).toBeDefined();
    expect(typeof sqliteDb.prepare).toBe('function');
  });

  it('should start with revision 0', () => {
    expect(db.getRevision()).toBe(0);
  });

  it('should set and increment revision', () => {
    db.setRevision(5);
    expect(db.getRevision()).toBe(5);

    const next = db.incrementRevision();
    expect(next).toBe(6);
    expect(db.getRevision()).toBe(6);
  });

  it('should return database path', () => {
    const dbPath = db.getDbPath();
    expect(dbPath).toContain('test.db');
  });

  it('should keep handles obtained before reopen() valid after reopen()', () => {
    // Regression test for backup.restore crash: services capture getDb() once
    // at construction time. After restore reopens the connection, those stale
    // handles must still work (via the proxy), otherwise every query throws
    // "The database connection is not open".
    const dbPath = join(tmpDir, 'reopen-test.db');
    const reopenDb = new EvolveFlowDatabase(dbPath);
    const staleHandle = reopenDb.getDb();
    staleHandle.prepare('CREATE TABLE IF NOT EXISTS probe (id INTEGER PRIMARY KEY)').run();
    staleHandle.prepare('INSERT INTO probe (id) VALUES (?)').run(1);

    reopenDb.close();
    reopenDb.reopen();

    // The handle captured before close must remain usable.
    const rows = staleHandle.prepare('SELECT id FROM probe').all() as Array<{ id: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(1);
    reopenDb.close();
  });
});

describe('ensureDataDirs', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'evolveflow-dirs-test-'));
  });

  it('should create all required data directories', () => {
    ensureDataDirs(tmpDir);

    const expectedDirs = ['memory', 'transcripts', 'exports', 'backups', 'logs'];
    for (const dir of expectedDirs) {
      expect(existsSync(join(tmpDir, dir))).toBe(true);
    }
  });
});

describe('BackupService restore', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'evolveflow-backup-test-'));
  });

  it('should keep all service handles usable after restoreFrom()', () => {
    // End-to-end regression for the connection-crash bug: restoreFrom() used
    // to close the shared connection and replace only its own reference,
    // leaving every other holder with a dead handle.
    const dataDir = join(tmpDir, 'app-data');
    ensureDataDirs(dataDir);
    const db = new EvolveFlowDatabase(join(dataDir, 'evolveflow.db'));

    // Simulate a domain service capturing the handle once at construction.
    const serviceHandle = db.getDb();
    serviceHandle
      .prepare(
        'INSERT INTO tasks (id, title, status, locked, time_effect_type) VALUES (?, ?, ?, ?, ?)'
      )
      .run('t1', 'original', 'pending', 0, 'continuous');

    const backupService = new BackupService(db, dataDir);
    const backupDir = backupService.backupTo(join(dataDir, 'backups'));

    // Mutate the DB so we can tell the restore actually happened.
    serviceHandle.prepare("UPDATE tasks SET title = 'mutated' WHERE id = 't1'").run();
    expect(
      (serviceHandle.prepare('SELECT title FROM tasks WHERE id = ?').get('t1') as { title: string })
        .title
    ).toBe('mutated');

    backupService.restoreFrom(backupDir);

    // After restore, the stale handle must still work and reflect the
    // restored (pre-mutation) data — not throw "connection is not open".
    const after = serviceHandle.prepare('SELECT title FROM tasks WHERE id = ?').get('t1') as {
      title: string;
    };
    expect(after.title).toBe('original');

    db.close();
  });
});
