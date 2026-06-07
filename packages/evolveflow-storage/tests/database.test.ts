import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { EvolveFlowDatabase, ensureDataDirs } from '../src/database.js';

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
