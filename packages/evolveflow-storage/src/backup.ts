import Database from 'better-sqlite3';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { EvolveFlowDatabase } from './database.js';

/**
 * Compute the SHA-256 hex digest of a file.
 */
function computeFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * List backup directories inside a parent path, sorted by timestamp descending (newest first).
 */
function listBackupsSorted(outputPath: string): string[] {
  const entries = fs.readdirSync(outputPath, { withFileTypes: true });
  const backupDirs = entries
    .filter((e) => e.isDirectory() && e.name.startsWith('evolveflow-backup-'))
    .map((e) => path.join(outputPath, e.name));
  // Sort descending by timestamp embedded in directory name
  backupDirs.sort((a, b) => b.localeCompare(a));
  return backupDirs;
}

export class BackupService {
  private db: EvolveFlowDatabase;
  private dataDir: string;

  constructor(db: EvolveFlowDatabase, dataDir: string) {
    this.db = db;
    this.dataDir = dataDir;
  }

  /**
   * Create a full backup at outputPath.
   * After creating the backup, enforces rotation by removing the oldest backups
   * beyond maxBackups (default 10).
   */
  backupTo(outputPath: string, maxBackups: number = 10): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(outputPath, `evolveflow-backup-${timestamp}`);
    fs.mkdirSync(backupDir, { recursive: true });

    const dbPath = path.join(this.dataDir, 'evolveflow.db');
    const dbBackupPath = path.join(backupDir, 'evolveflow.db');
    this.db.getDb().pragma('wal_checkpoint(TRUNCATE)');
    fs.copyFileSync(dbPath, dbBackupPath);

    const memoryDir = path.join(this.dataDir, 'memory');
    if (fs.existsSync(memoryDir)) {
      const memoryBackupDir = path.join(backupDir, 'memory');
      fs.mkdirSync(memoryBackupDir, { recursive: true });
      const files = fs.readdirSync(memoryDir);
      for (const file of files) {
        fs.copyFileSync(path.join(memoryDir, file), path.join(memoryBackupDir, file));
      }
    }

    const dbHash = computeFileHash(dbBackupPath);

    const manifest = {
      version: '1.1',
      timestamp: new Date().toISOString(),
      revision: this.db.getRevision(),
      dbHash,
    };
    fs.writeFileSync(
      path.join(backupDir, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf-8'
    );

    // Enforce backup rotation: keep at most maxBackups
    const allBackups = listBackupsSorted(outputPath);
    if (allBackups.length > maxBackups) {
      const toDelete = allBackups.slice(maxBackups);
      for (const old of toDelete) {
        fs.rmSync(old, { recursive: true });
      }
      console.log(
        `Backup rotation: removed ${toDelete.length} old backup(s), keeping ${maxBackups}`
      );
    }

    return backupDir;
  }

  /**
   * Verify backup integrity by checking the SHA-256 hash and running PRAGMA integrity_check.
   */
  verifyBackup(backupDir: string): boolean {
    const manifestPath = path.join(backupDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      console.error('Verify failed: manifest.json not found');
      return false;
    }

    const manifestRaw = fs.readFileSync(manifestPath, 'utf-8');
    let manifest: { version?: string; dbHash?: string };
    try {
      manifest = JSON.parse(manifestRaw);
    } catch {
      console.error('Verify failed: manifest.json is not valid JSON');
      return false;
    }

    const dbBackupPath = path.join(backupDir, 'evolveflow.db');
    if (!fs.existsSync(dbBackupPath)) {
      console.error('Verify failed: evolveflow.db not found');
      return false;
    }

    // Check hash
    if (manifest.dbHash) {
      const actualHash = computeFileHash(dbBackupPath);
      if (actualHash !== manifest.dbHash) {
        console.error(
          `Verify failed: hash mismatch (expected ${manifest.dbHash}, got ${actualHash})`
        );
        return false;
      }
    }

    // Run PRAGMA integrity_check on a temporary open of the backup db
    const tempDb = new Database(dbBackupPath);
    try {
      const row = tempDb.pragma('integrity_check', { simple: true }) as string;
      if (row !== 'ok') {
        console.error(`Verify failed: integrity_check returned "${row}"`);
        return false;
      }
    } finally {
      tempDb.close();
    }

    console.log(`Backup verified successfully: ${backupDir}`);
    return true;
  }

  /**
   * Restore database and memory from a backup directory.
   * Before replacing, the current database state is backed up as a safety "restore-point".
   */
  restoreFrom(backupDir: string): void {
    const manifestPath = path.join(backupDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('Invalid backup: missing manifest.json');
    }

    const dbBackupPath = path.join(backupDir, 'evolveflow.db');
    if (!fs.existsSync(dbBackupPath)) {
      throw new Error('Invalid backup: missing evolveflow.db');
    }

    // --- Safety net: create a restore-point backup before replacing ---
    const restorePointDir = path.join(
      this.dataDir,
      'backups',
      `restore-point-${new Date().toISOString().replace(/[:.]/g, '-')}`
    );
    fs.mkdirSync(restorePointDir, { recursive: true });

    const dbPath = path.join(this.dataDir, 'evolveflow.db');
    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, path.join(restorePointDir, 'evolveflow.db'));
    }

    const currentMemoryDir = path.join(this.dataDir, 'memory');
    if (fs.existsSync(currentMemoryDir)) {
      const restoreMemoryDir = path.join(restorePointDir, 'memory');
      fs.mkdirSync(restoreMemoryDir, { recursive: true });
      const files = fs.readdirSync(currentMemoryDir);
      for (const file of files) {
        fs.copyFileSync(path.join(currentMemoryDir, file), path.join(restoreMemoryDir, file));
      }
    }

    // Write a manifest for the restore-point
    const restoreManifest = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      type: 'restore-point',
    };
    fs.writeFileSync(
      path.join(restorePointDir, 'manifest.json'),
      JSON.stringify(restoreManifest, null, 2),
      'utf-8'
    );
    console.log(`Restore-point created at ${restorePointDir}`);

    // --- Perform the restore ---
    // Close the live connection so the underlying file can be replaced on
    // disk, then reopen it. reopen() swaps the internal connection while
    // keeping every handle obtained via getDb() (held by the domain services)
    // valid through the proxy — without it, all those handles would be dead.
    this.db.close();

    fs.copyFileSync(dbBackupPath, dbPath);

    const memoryBackupDir = path.join(backupDir, 'memory');
    if (fs.existsSync(memoryBackupDir)) {
      const memoryDir = path.join(this.dataDir, 'memory');
      if (fs.existsSync(memoryDir)) {
        fs.rmSync(memoryDir, { recursive: true });
      }
      fs.mkdirSync(memoryDir, { recursive: true });
      const files = fs.readdirSync(memoryBackupDir);
      for (const file of files) {
        fs.copyFileSync(path.join(memoryBackupDir, file), path.join(memoryDir, file));
      }
    }

    // Reopen the same EvolveFlowDatabase against the restored file.
    this.db.reopen();

    // Rebuild reminder queue from restored database
    const pendingReminders = this.db
      .getDb()
      .prepare(
        "SELECT id, trigger_at, message, task_id, event_id FROM reminders WHERE status = 'pending'"
      )
      .all() as Record<string, unknown>[];
    console.log(`Restored ${pendingReminders.length} pending reminders`);
  }
}
