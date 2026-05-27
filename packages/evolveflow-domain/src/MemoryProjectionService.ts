import type Database from 'better-sqlite3';
import { PreferenceService } from './PreferenceService.js';

export class MemoryProjectionService {
  private db: Database.Database;
  private preferenceService: PreferenceService;

  constructor(db: Database.Database, preferenceService: PreferenceService) {
    this.db = db;
    this.preferenceService = preferenceService;
  }

  projectFromDream(dreamOutput: Record<string, unknown>): void {
    if (dreamOutput.preferred_work_hours) {
      const hours = dreamOutput.preferred_work_hours as { start: string; end: string };
      this.preferenceService.setWorkHours(hours.start, hours.end);
    }
    if (dreamOutput.task_preferences) {
      this.preferenceService.set('learned_task_preferences', JSON.stringify(dreamOutput.task_preferences));
    }
    this.preferenceService.recordSignal('dream_projection', dreamOutput, 'dream');
  }

  clearDreamProjections(): void {
    this.db.prepare("DELETE FROM preference_signals WHERE source = 'dream'").run();
    this.db.prepare("DELETE FROM preferences WHERE key = 'learned_task_preferences'").run();
  }

  clearAllLearnedState(): void {
    this.db.prepare("DELETE FROM preference_signals").run();
    const keysToKeep = ['work_hours_start', 'work_hours_end'];
    this.db.prepare(`DELETE FROM preferences WHERE key NOT IN (${keysToKeep.map(() => '?').join(',')})`).run(...keysToKeep);
  }
}
