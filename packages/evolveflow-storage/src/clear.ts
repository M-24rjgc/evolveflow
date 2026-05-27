import * as fs from 'fs';
import * as path from 'path';
import type Database from 'better-sqlite3';

export class ClearService {
  private db: Database.Database;
  private memoryDir: string;

  constructor(db: Database.Database, dataDir: string) {
    this.db = db;
    this.memoryDir = path.join(dataDir, 'memory');
  }

  clearAIHistory(): void {
    this.db.prepare('DELETE FROM ai_messages').run();
    this.db.prepare('DELETE FROM ai_sessions').run();
  }

  clearLearnedState(includeDream: boolean = true): void {
    this.db.prepare("DELETE FROM preference_signals WHERE source = 'dream'").run();
    this.db.prepare("DELETE FROM preferences WHERE key NOT IN ('work_hours_start', 'work_hours_end', 'schema_version', 'revision')").run();

    if (includeDream) {
      this.clearDreamMemory();
    }
  }

  clearDreamMemory(): void {
    if (fs.existsSync(this.memoryDir)) {
      const normalizedMemoryDir = path.resolve(this.memoryDir);
      const dreamFiles = fs.readdirSync(this.memoryDir).filter((f) => f.startsWith('dream-'));
      for (const file of dreamFiles) {
        const filePath = path.resolve(path.join(this.memoryDir, file));
        // Path traversal protection: ensure resolved path is within memoryDir
        if (!filePath.startsWith(normalizedMemoryDir)) {
          console.warn(`Skipping file outside memory directory: ${file}`);
          continue;
        }
        fs.unlinkSync(filePath);
      }
    }
  }

  clearAllAIData(): void {
    this.clearAIHistory();
    this.clearLearnedState(true);
  }
}
