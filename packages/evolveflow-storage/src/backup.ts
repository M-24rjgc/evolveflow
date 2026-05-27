import * as fs from 'fs';
import * as path from 'path';
import { EvolveFlowDatabase } from './database.js';

export class BackupService {
  private db: EvolveFlowDatabase;
  private dataDir: string;

  constructor(db: EvolveFlowDatabase, dataDir: string) {
    this.db = db;
    this.dataDir = dataDir;
  }

  backupTo(outputPath: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupDir = path.join(outputPath, `evolveflow-backup-${timestamp}`);
    fs.mkdirSync(backupDir, { recursive: true });

    const dbPath = path.join(this.dataDir, 'evolveflow.db');
    const dbBackupPath = path.join(backupDir, 'evolveflow.db');
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

    const manifest = {
      version: '1.0',
      timestamp: new Date().toISOString(),
      revision: this.db.getRevision(),
    };
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

    return backupDir;
  }

  restoreFrom(backupDir: string): void {
    const manifestPath = path.join(backupDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      throw new Error('Invalid backup: missing manifest.json');
    }

    const dbBackupPath = path.join(backupDir, 'evolveflow.db');
    if (!fs.existsSync(dbBackupPath)) {
      throw new Error('Invalid backup: missing evolveflow.db');
    }

    this.db.close();

    const dbPath = path.join(this.dataDir, 'evolveflow.db');
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

    // Rebuild reminder queue from restored database
    this.db = new EvolveFlowDatabase(dbPath);
    const pendingReminders = this.db.getDb().prepare(
      "SELECT id, trigger_at, message, task_id, event_id FROM reminders WHERE status = 'pending'"
    ).all() as Record<string, unknown>[];
    // Reminders are now available for the ReminderService to pick up
    console.log(`Restored ${pendingReminders.length} pending reminders`);
  }
}
