import type Database from 'better-sqlite3';
import { PreferenceService } from './PreferenceService.js';

// ── Types ──────────────────────────────────────────────────────

/** Structured projection data from dream analysis, designed to be
 *  constructed from a DreamAnalysisResult (defined in the runtime). */
export interface DreamProjectionData {
  /** Inferred ideal work hours, e.g. { start: '09:00', end: '17:00' } */
  preferredWorkHours?: { start: string; end: string };
  /** Learned energy curves: peak hours, low hours, variability */
  energyPatterns?: Record<string, unknown>;
  /** Schedule adherence metrics: rate, trend, common disruptions */
  scheduleAdherence?: Record<string, unknown>;
  /** Productivity trend description */
  productivityTrend?: string;
  /** Preferred/avoided task types */
  taskPreferences?: Record<string, unknown>;
  /** Per-insight details for signal recording */
  insights?: Array<{
    id: string;
    category: string;
    description: string;
    confidence: number;
    suggestion: string;
  }>;
  /** Overall confidence of the analysis */
  confidence: number;
}

/** Keys in the `preferences` table that were set by the dream system.
 *  Used to allow clean selective rollback. */
const DREAM_SET_KEYS = new Set([
  'learned_work_hours_start',
  'learned_work_hours_end',
  'learned_energy_patterns',
  'learned_adherence_rate',
  'learned_productivity_trend',
  'learned_task_preferences',
]);

export class MemoryProjectionService {
  private db: Database.Database;
  private preferenceService: PreferenceService;

  constructor(db: Database.Database, preferenceService: PreferenceService) {
    this.db = db;
    this.preferenceService = preferenceService;
  }

  /**
   * Project a DreamAnalysisResult into the user's preference and signal system.
   *
   * Extracts and stores:
   *  - preferred_work_hours -> preferenceService.setWorkHours()
   *  - energy_patterns      -> preferenceService.set('learned_energy_patterns', ...)
   *  - schedule_adherence   -> preferenceService.set('learned_adherence_rate', ...)
   *  - productivity_trend   -> preferenceService.set('learned_productivity_trend', ...)
   *  - task_preferences     -> preferenceService.set('learned_task_preferences', ...)
   *  - per-insight signals  -> preferenceService.recordSignal('dream_insight', ...)
   *  - confidence signal    -> preferenceService.recordSignal('dream_confidence', ...)
   */
  projectFromDream(dreamOutput: DreamProjectionData): void {
    // 1. Work hours
    if (dreamOutput.preferredWorkHours) {
      const { start, end } = dreamOutput.preferredWorkHours;
      this.preferenceService.set('learned_work_hours_start', start);
      this.preferenceService.set('learned_work_hours_end', end);
      this.preferenceService.setWorkHours(start, end);
    }

    // 2. Energy patterns
    if (dreamOutput.energyPatterns) {
      this.preferenceService.set(
        'learned_energy_patterns',
        JSON.stringify(dreamOutput.energyPatterns),
      );
    }

    // 3. Schedule adherence
    if (dreamOutput.scheduleAdherence) {
      this.preferenceService.set(
        'learned_adherence_rate',
        JSON.stringify(dreamOutput.scheduleAdherence),
      );
    }

    // 4. Productivity trend
    if (dreamOutput.productivityTrend) {
      this.preferenceService.set('learned_productivity_trend', dreamOutput.productivityTrend);
    }

    // 5. Task preferences
    if (dreamOutput.taskPreferences) {
      this.preferenceService.set(
        'learned_task_preferences',
        JSON.stringify(dreamOutput.taskPreferences),
      );
    }

    // 6. Record per-insight signals
    if (dreamOutput.insights) {
      for (const insight of dreamOutput.insights) {
        if (insight.confidence >= 0.5) {
          this.preferenceService.recordSignal(
            'dream_insight',
            {
              category: insight.category,
              description: insight.description,
              confidence: insight.confidence,
              suggestion: insight.suggestion,
            },
            'dream',
          );
        }
      }
    }

    // 7. Overall confidence signal
    this.preferenceService.recordSignal(
      'dream_confidence',
      { overall: dreamOutput.confidence, timestamp: new Date().toISOString() },
      'dream',
    );

    // 8. Record the full projection as a single signal for traceability
    this.preferenceService.recordSignal('dream_projection', {
      projectedWorkHours: !!dreamOutput.preferredWorkHours,
      projectedEnergy: !!dreamOutput.energyPatterns,
      projectedAdherence: !!dreamOutput.scheduleAdherence,
      projectedProductivity: !!dreamOutput.productivityTrend,
      projectedTasks: !!dreamOutput.taskPreferences,
      insightCount: dreamOutput.insights?.length ?? 0,
      confidence: dreamOutput.confidence,
    }, 'dream');
  }

  /**
   * Clear all projections that were set by the dream system.
   * Removes:
   *  - All preference_signals with source='dream'
   *  - All dream-set preference keys (including work hours)
   */
  clearDreamProjections(): void {
    this.db.prepare("DELETE FROM preference_signals WHERE source = 'dream'").run();

    // Delete known dream-set keys
    const keysArray = Array.from(DREAM_SET_KEYS);
    const placeholders = keysArray.map(() => '?').join(',');
    this.db.prepare(`DELETE FROM preferences WHERE key IN (${placeholders})`).run(...keysArray);

    // Also reset work hours to app defaults
    this.preferenceService.setWorkHours('09:00', '18:00');
  }

  /**
   * Clear ALL learned state, including both dream projections
   * and any other preference signals.  Keeps only the base
   * work_hours_start / work_hours_end keys.
   *
   * @param preserveDreamProjections  When true, dream-sourced signals
   *                                  are preserved (for includeDream=false).
   */
  clearAllLearnedState(preserveDreamProjections?: boolean): void {
    if (preserveDreamProjections) {
      this.db.prepare("DELETE FROM preference_signals WHERE source IS NULL OR source != 'dream'").run();
    } else {
      this.db.prepare("DELETE FROM preference_signals").run();
    }
    const keysToKeep = ['work_hours_start', 'work_hours_end'];
    this.db.prepare(
      `DELETE FROM preferences WHERE key NOT IN (${keysToKeep.map(() => '?').join(',')})`,
    ).run(...keysToKeep);
  }

  /** Check whether any dream projections currently exist */
  hasDreamProjections(): boolean {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM preference_signals WHERE source = 'dream'")
      .get() as { count: number };
    return row.count > 0;
  }

  /** Get the set of keys currently stored by the dream system (useful for debugging) */
  getDreamSetKeys(): string[] {
    const rows = this.db
      .prepare(`SELECT key FROM preferences WHERE key IN (${Array.from(DREAM_SET_KEYS).map(() => '?').join(',')})`)
      .all(...Array.from(DREAM_SET_KEYS)) as Array<{ key: string }>;
    return rows.map((r) => r.key);
  }
}
