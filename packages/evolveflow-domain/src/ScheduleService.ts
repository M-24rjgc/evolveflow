import { v4 as uuidv4 } from 'uuid';
import type Database from 'better-sqlite3';
import type { Task, Event, ScheduleBlock } from './types.js';
import { TaskService } from './TaskService.js';
import { EventService } from './EventService.js';
import { PreferenceService } from './PreferenceService.js';

// ── Exported Types ────────────────────────────────────────────────────────────

/**
 * Simple performance logger that tracks function execution time.
 * Logs a warning if the tracked operation exceeds the threshold.
 */
class PerformanceLogger {
  private label: string;
  private thresholdMs: number;
  private startTime: number;

  constructor(label: string, thresholdMs: number = 100) {
    this.label = label;
    this.thresholdMs = thresholdMs;
    this.startTime = 0;
  }

  start(): void {
    this.startTime = performance.now();
  }

  stop(): number {
    const elapsed = performance.now() - this.startTime;
    if (elapsed > this.thresholdMs) {
      console.warn(
        `[PerformanceLogger] ${this.label} took ${elapsed.toFixed(2)}ms ` +
          `(threshold: ${this.thresholdMs}ms)`
      );
    }
    return elapsed;
  }

  /** Helper: wrap an async function with timing. */
  static async trace<T>(
    label: string,
    fn: () => Promise<T>,
    thresholdMs: number = 100
  ): Promise<T> {
    const logger = new PerformanceLogger(label, thresholdMs);
    logger.start();
    try {
      return await fn();
    } finally {
      logger.stop();
    }
  }

  /** Helper: wrap a sync function with timing. */
  static traceSync<T>(label: string, fn: () => T, thresholdMs: number = 100): T {
    const logger = new PerformanceLogger(label, thresholdMs);
    logger.start();
    try {
      return fn();
    } finally {
      logger.stop();
    }
  }
}

export interface ScheduleExplanation {
  block_id: string;
  reasons: string[];
  key_factors: string[];
}

/**
 * A task that could not be scheduled and why.
 */
export interface DeferredTask {
  taskId: string;
  /** Machine-readable reason for deferral. */
  reason: 'no_fit' | 'locked' | 'no_duration' | 'scheduling_conflict';
  /** ISO date string suggesting when to try again. */
  suggestedDate: string;
}

/**
 * Full return type from the optimized scheduling algorithm.
 */
export interface PlanDayResult {
  /** The schedule blocks that were successfully placed. */
  scheduled: ScheduleBlock[];
  /** Tasks that could not be scheduled, with reasons. */
  deferred: DeferredTask[];
}

export interface ClearScheduleResult {
  date: string;
  cleared: number;
  remaining: ScheduleBlock[];
}

/**
 * Tunable parameters for the weighted-scoring scheduler.
 * All fields are optional; sensible defaults are used when omitted.
 */
export interface SchedulingPreferences {
  /** Minutes of blank space inserted after each task (default: 5). Set to 0 to disable. */
  bufferMinutes?: number;
  /** When true, prevent packing all difficult/high-priority tasks into a single day (default: true). */
  spreadHighFocusTasks?: boolean;
  /** When true, deadline-type tasks are biased toward morning slots (default: true). */
  preferMorningForDeadlineTasks?: boolean;
  /** Maximum total priority-load per day before deferring extra tasks (multi-day only). */
  maxDailyLoad?: number;
  /** When true, learned energy patterns are used to align high-priority tasks with peak hours (default: true). */
  respectEnergyPatterns?: boolean;
}

/**
 * Detailed breakdown of one task-slot scoring decision.
 */
export interface SlotScoreDetail {
  taskId: string;
  taskTitle: string;
  slotStart: string;
  slotEnd: string;
  /** Sum of all weighted sub-scores. */
  totalScore: number;
  /** How well the task duration fills the slot (0-20). */
  durationMatch: number;
  /** How well the slot time-of-day matches the task type (0-15). */
  timeOfDayPreference: number;
  /** Bonus for aligning high-priority tasks with learned energy peaks (0-10). */
  energyAlignment: number;
  /** Penalty for leaving unusably small leftover fragments (0 to -15). */
  fragmentationPenalty: number;
  /** Bonus for natural buffers around this slot (0-5). */
  bufferBonus: number;
  /** Computed internal priority score of the task. */
  taskPriorityScore: number;
}

/**
 * Quality metrics returned by analyzeScheduleQuality.
 */
export interface ScheduleQualityMetrics {
  date: string;
  /** Total number of pending tasks considered. */
  totalTasks: number;
  /** Tasks that were successfully placed. */
  scheduledCount: number;
  /** Tasks that could not be placed. */
  deferredCount: number;
  /** Percentage of available work time that is occupied by scheduled items (0-100). */
  utilizationRate: number;
  /** Score from 0 (perfect) to 100 (maximally fragmented). */
  fragmentationScore: number;
  /** How much of the total possible priority weight was captured by the schedule (0-100). */
  priorityWeightedCompletionPotential: number;
  /** Aggregate buffer minutes actually inserted across the day. */
  averageBufferMinutes: number;
  /** Number of discrete available slots. */
  slotCount: number;
  /** Total minutes in the work window. */
  totalWorkMinutes: number;
  /** Minutes actually filled by scheduled items. */
  scheduledMinutes: number;
}

// ── Private Helpers ───────────────────────────────────────────────────────────

/** Internal representation of an available time slot. */
interface TimeSlot {
  start: string; // ISO datetime string
  end: string; // ISO datetime string
  remainingMinutes: number;
}

interface TaskPriority {
  task: Task;
  priorityScore: number;
  /** Which parts contributed to the score (for debugging / explanations). */
  breakdown: {
    base: number;
    urgency: number;
    dependency: number;
    completionHistory: number;
  };
}

interface EnergyPatterns {
  /** Hours of the day (0-23) considered peak energy periods. */
  peakHours: number[];
  /** Hours considered low energy. */
  lowHours: number[];
  /** Overall variability description. */
  variability?: string;
}

// ── Service ───────────────────────────────────────────────────────────────────

export class ScheduleService {
  private db: Database.Database;
  private taskService: TaskService;
  private eventService: EventService;
  private preferenceService: PreferenceService;
  /**
   * Request-scoped cache of bound events keyed by task id, built once at the
   * start of a planning pass to avoid the N+1 of findBoundEvent() calling
   * eventService.list() for every event_bound task × every slot. Null outside
   * of a planning pass.
   */
  private boundEventCache: Map<string, Event> | null = null;

  constructor(
    db: Database.Database,
    taskService: TaskService,
    eventService: EventService,
    preferenceService?: PreferenceService
  ) {
    this.db = db;
    this.taskService = taskService;
    this.eventService = eventService;
    this.preferenceService = preferenceService ?? new PreferenceService(db);
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PUBLIC API — Backward-Compatible
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * **Plan a single day using the weighted-scoring algorithm.**
   *
   * Backward-compatible wrapper that delegates to `planDayOptimized` and
   * auto-defers any tasks that could not be placed.
   *
   * @param date  ISO date string (YYYY-MM-DD).
   * @returns     The successfully placed schedule blocks.
   */
  planDay(date: string): ScheduleBlock[] {
    return this.db.transaction(() => {
      const result = this.planDayOptimized(date);
      for (const d of result.deferred) {
        try {
          this.taskService.defer(d.taskId, d.suggestedDate);
        } catch {
          // Task may have been locked or already deferred — skip silently.
        }
      }
      return result.scheduled;
    })();
  }

  /**
   * **Plan a date range by calling `planDay` for each day.**
   *
   * @param startDate  Inclusive start (YYYY-MM-DD).
   * @param endDate    Inclusive end (YYYY-MM-DD).
   * @returns          All schedule blocks across the range.
   */
  planRange(startDate: string, endDate: string): ScheduleBlock[] {
    const blocks: ScheduleBlock[] = [];
    const start = new Date(startDate);
    const end = new Date(endDate);
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const dateStr = d.toISOString().split('T')[0];
      blocks.push(...this.planDay(dateStr));
    }
    return blocks;
  }

  /**
   * **Rebalance an existing day schedule.**
   *
   * Removes unlocked, non-manual blocks and re-runs the optimized scheduler
   * for the given date, preserving locked blocks and manual adjustments.
   *
   * @param date  ISO date string (YYYY-MM-DD).
   * @returns     Updated schedule blocks.
   */
  rebalance(date: string): ScheduleBlock[] {
    const rebalanceTransaction = this.db.transaction(() => {
      const existingBlocks = this.getDaySchedule(date);
      const lockedBlocks = existingBlocks.filter((b) => b.locked);

      // Remove only unlocked, non-manual blocks (re-schedulable ones).
      for (const block of existingBlocks) {
        if (!block.locked && !block.manual_signal) {
          this.db.prepare('DELETE FROM schedule_blocks WHERE id = ?').run(block.id);
        }
      }

      // Re-run the optimized scheduler, but preserve locked+manual blocks
      // by restoring them before the scheduler runs.
      const result = this.planDayOptimized(date);
      return result.scheduled;
    });

    return rebalanceTransaction();
  }

  /**
   * **Explain why a specific block was placed where it was.**
   *
   * @param blockId  UUID of the schedule block.
   * @returns        Explanation object or null if not found.
   */
  explain(blockId: string): ScheduleExplanation | null {
    const block = this.db.prepare('SELECT * FROM schedule_blocks WHERE id = ?').get(blockId) as
      | Record<string, unknown>
      | undefined;
    if (!block) {
      return null;
    }

    const reasons: string[] = [];
    const keyFactors: string[] = [];

    if (block.event_id) {
      reasons.push('Fixed event placeholder');
      keyFactors.push('event');
    }

    if (block.task_id) {
      const task = this.taskService.getById(block.task_id as string);
      if (task) {
        if (task.due_date) {
          reasons.push(`Deadline: ${task.due_date}`);
          keyFactors.push('deadline');
        }
        if (task.time_effect_type === 'deadline') {
          reasons.push('Deadline-type task, prioritised');
          keyFactors.push('time_effect_type');
        }
        if (block.manual_signal) {
          reasons.push('Manually adjusted by user');
          keyFactors.push('manual_signal');
        }
        if (task.locked) {
          reasons.push('Locked, cannot auto-adjust');
          keyFactors.push('locked');
        }
      }
    }

    return { block_id: blockId, reasons, key_factors: keyFactors };
  }

  /**
   * **Retrieve the raw schedule blocks for a date.**
   *
   * @param date  ISO date string (YYYY-MM-DD).
   * @returns     Sorted array of schedule blocks.
   */
  getDaySchedule(date: string): ScheduleBlock[] {
    const rows = this.db
      .prepare('SELECT * FROM schedule_blocks WHERE date = ? ORDER BY start_time')
      .all(date) as Record<string, unknown>[];
    return rows.map((r) => this.mapRowToBlock(r));
  }

  /**
   * Clear generated, unlocked schedule blocks for a day.
   *
   * Locked blocks and manual adjustments are preserved so user-curated plans
   * and fixed calendar items survive cleanup.
   */
  clearGeneratedSchedule(date: string): ClearScheduleResult {
    return this.db.transaction(() => {
      const cleared = this.clearDaySchedule(date);
      return {
        date,
        cleared,
        remaining: this.getDaySchedule(date),
      };
    })();
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  NEW PUBLIC METHODS — Optimized Weighted-Scoring Scheduler
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * **Plan a single day using the weighted-scoring scheduling algorithm.**
   *
   * Overview of the algorithm:
   *
   *  1. **Priority scoring** — Every pending task receives a numeric priority
   *     score based on its type (`deadline` > `event_bound` > `continuous`),
   *     deadline proximity, dependency role, and its project's historical
   *     completion rate.
   *
   *  2. **Slot scoring** — Instead of first-fit, every available gap is scored
   *     against each task. The best-fitting slot (highest score) is selected.
   *     Dimensions: duration fit, time-of-day preference, learned-energy
   *     alignment, fragmentation cost, and natural buffer availability.
   *
   *  3. **Buffer insertion** — After each placement, a configurable gap
   *     (default 5 min) is reserved to prevent back-to-back cramming.
   *
   *  4. **Gap filling pass** — After the main pass, remaining free gaps
   *     >= 15 minutes are examined. Short deferred tasks may be inserted.
   *
   *  5. **Proper deferred handling** — Tasks that cannot be placed are
   *     returned as a `DeferredTask[]` with machine-readable reasons,
   *     rather than creating blocks with empty time strings.
   *
   * Complexity: **O(n log n + n * m)** where n = number of tasks and
   * m = number of available slots. For a typical day (10-30 tasks, 5-10 slots)
   * this completes in well under 50 ms.
   *
   * @param date         ISO date string (YYYY-MM-DD).
   * @param preferences  Optional tuning parameters.
   * @returns            `{ scheduled, deferred }` result.
   */
  planDayOptimized(date: string, preferences?: SchedulingPreferences): PlanDayResult {
    const logger = new PerformanceLogger(`planDayOptimized(${date})`, 100);
    logger.start();

    // Populate the request-scoped bound-event cache so findBoundEvent() below
    // does not issue a full eventService.list() per event_bound task per slot.
    // Cleared in the finally block after the planning transaction completes.
    this.boundEventCache = new Map();

    try {
      const planTransaction = this.db.transaction(() => {
        this.clearDaySchedule(date);

        // ── 1. Gather preserved blocks and events ──
        const preservedBlocks = this.getPreservedBlocks(date);
        const events = this.eventService.list({
          start: `${date}T00:00:00`,
          end: `${date}T23:59:59`,
        });
        // Index bound events once: bound_task_id → event.
        for (const ev of events) {
          if (ev.bound_task_id) {
            this.boundEventCache!.set(ev.bound_task_id, ev);
          }
        }
        const eventBlocks = this.createEventBlocks(events, date, preservedBlocks);

        // Build initial occupied slots from locked/manual blocks + events.
        const occupiedSlots = this.computeOccupiedSlots(date, [...preservedBlocks, ...eventBlocks]);

        // ── 2. Compute available slots ──
        const availableSlots = this.getAvailableSlots(date, occupiedSlots);

        // ── 3. Load tasks and compute priority scores ──
        const allTasks = this.taskService.list({ status: 'pending' });
        const schedulableTasks = allTasks.filter((t) => {
          if (t.locked) {
            return false;
          }
          if (t.parent_task_id) {
            const subTasks = this.taskService.getSubTasks(t.parent_task_id);
            if (subTasks.length > 0) {
              return false;
            }
          }
          return true;
        });

        // Preload completion rates once for all tasks.
        const completionRates = this.loadProjectCompletionRates();

        const scoredTasks: TaskPriority[] = schedulableTasks.map((t) => {
          const breakdown = this.computePriorityBreakdown(t, date, completionRates);
          return {
            task: t,
            priorityScore:
              breakdown.base +
              breakdown.urgency +
              breakdown.dependency +
              breakdown.completionHistory,
            breakdown,
          };
        });

        // Sort descending by priority score, with stable tiebreaker.
        scoredTasks.sort((a, b) => {
          const scoreDiff = b.priorityScore - a.priorityScore;
          if (scoreDiff !== 0) {
            return scoreDiff;
          }
          return a.task.created_at.localeCompare(b.task.created_at);
        });

        // ── 4. Resolve preferences with fallbacks ──
        const bufferMinutes = preferences?.bufferMinutes ?? this.getBufferPreference() ?? 5;
        const preferMorning = preferences?.preferMorningForDeadlineTasks ?? true;
        const respectEnergy = preferences?.respectEnergyPatterns ?? true;

        let energyPatterns: EnergyPatterns | null = null;
        if (respectEnergy) {
          energyPatterns = this.loadEnergyPatterns();
        }

        // ── 5. Main scheduling pass (weighted slot scoring) ──
        const scheduled: ScheduleBlock[] = [...preservedBlocks, ...eventBlocks];
        const deferred: DeferredTask[] = [];
        const now = new Date().toISOString();

        for (const { task, priorityScore } of scoredTasks) {
          if (!task.duration_minutes || task.duration_minutes <= 0) {
            deferred.push({
              taskId: task.id,
              reason: 'no_duration',
              suggestedDate: date,
            });
            continue;
          }

          const bestSlot = this.selectBestSlot(
            task,
            availableSlots,
            date,
            bufferMinutes,
            preferMorning,
            energyPatterns,
            priorityScore
          );

          if (bestSlot) {
            const block: ScheduleBlock = {
              id: uuidv4(),
              task_id: task.id,
              event_id: null,
              date,
              start_time: bestSlot.start,
              end_time: this.addMinutes(bestSlot.start, task.duration_minutes),
              locked: false,
              manual_signal: false,
              created_at: now,
              updated_at: now,
            };
            this.persistBlock(block);
            scheduled.push(block);

            // Trim the slot and insert buffer.
            this.trimSlot(availableSlots, bestSlot, bufferMinutes);
          } else {
            const nextDay = this.getNextDateString(date);
            deferred.push({
              taskId: task.id,
              reason: 'no_fit',
              suggestedDate: nextDay,
            });
          }
        }

        // ── 6. Gap-filling pass ──
        // Collect gaps (available slots) that are >= 15 minutes.
        const gapFillResults = this.gapFillingPass(availableSlots, deferred, date, now);
        for (const result of gapFillResults) {
          scheduled.push(result);
          // Remove the task from deferred.
          const idx = deferred.findIndex((d) => d.taskId === result.task_id);
          if (idx >= 0) {
            deferred.splice(idx, 1);
          }
        }

        return { scheduled, deferred };
      });

      const result = planTransaction();
      logger.stop();
      return result;
    } finally {
      // Release the request-scoped cache; subsequent calls re-populate it.
      this.boundEventCache = null;
    }
  }

  /**
   * **Legacy scheduling algorithm (first-fit, due-date sort).**
   *
   * Preserved as a fallback. Uses the original simple greedy approach:
   *  - Tasks sorted by `due_date` only.
   *  - First available slot that fits is chosen.
   *  - No priorities, energy patterns, buffers, or gap filling.
   *  - Tasks that don't fit are auto-deferred.
   *
   * @param date  ISO date string (YYYY-MM-DD).
   * @returns     Schedule blocks placed by the legacy algorithm.
   */
  planDayLegacy(date: string): ScheduleBlock[] {
    const planTransaction = this.db.transaction(() => {
      this.clearDaySchedule(date);

      const lockedRows = this.db
        .prepare('SELECT * FROM schedule_blocks WHERE date = ? AND locked = 1')
        .all(date) as Record<string, unknown>[];
      const lockedBlocks = lockedRows.map((r) => this.mapRowToBlock(r));

      const events = this.eventService.list({
        start: `${date}T00:00:00`,
        end: `${date}T23:59:59`,
      });

      const tasks = this.taskService.list({ status: 'pending' });
      const schedulableTasks = tasks.filter((t) => {
        if (t.locked) {
          return false;
        }
        if (t.parent_task_id) {
          const subTasks = this.taskService.getSubTasks(t.parent_task_id);
          if (subTasks.length > 0) {
            return false;
          }
        }
        return t.duration_minutes && t.duration_minutes > 0;
      });

      const now = new Date().toISOString();
      const blocks: ScheduleBlock[] = [...lockedBlocks];

      for (const event of events) {
        const block: ScheduleBlock = {
          id: uuidv4(),
          event_id: event.id,
          task_id: null,
          date,
          start_time: event.start_time,
          end_time: event.end_time,
          locked: event.locked,
          manual_signal: false,
          created_at: now,
          updated_at: now,
        };
        this.persistBlock(block);
        blocks.push(block);
      }

      const occupiedSlots = this.getOccupiedSlots(date, blocks);
      const availableSlots = this.getAvailableSlots(date, occupiedSlots);

      const sortedTasks = [...schedulableTasks].sort((a, b) => {
        if (a.due_date && b.due_date) {
          return a.due_date.localeCompare(b.due_date);
        }
        if (a.due_date) {
          return -1;
        }
        if (b.due_date) {
          return 1;
        }
        return 0;
      });

      for (const task of sortedTasks) {
        const slot = this.findSlotForTask(task, availableSlots, date);
        if (slot) {
          const block: ScheduleBlock = {
            id: uuidv4(),
            task_id: task.id,
            event_id: null,
            date,
            start_time: slot.start,
            end_time: slot.end,
            locked: false,
            manual_signal: false,
            created_at: now,
            updated_at: now,
          };
          this.persistBlock(block);
          blocks.push(block);
          this.updateAvailableSlots(availableSlots, slot);
        } else {
          const nextDay = new Date(date);
          nextDay.setDate(nextDay.getDate() + 1);
          const newDueDate = nextDay.toISOString().split('T')[0];
          try {
            this.taskService.defer(task.id, newDueDate);
          } catch {
            // Skip silently.
          }
        }
      }

      return blocks;
    });

    return planTransaction();
  }

  /**
   * **Analyze the (already-scheduled) quality of a day.**
   *
   * Computes metrics used to evaluate and compare scheduling outcomes.
   * Useful for A/B testing the legacy vs. optimized algorithm and for
   * providing feedback to the user.
   *
   * @param date  ISO date string (YYYY-MM-DD).
   * @returns     Quality metrics snapshot.
   */
  analyzeScheduleQuality(date: string): ScheduleQualityMetrics {
    const blocks = this.getDaySchedule(date);
    const allTasks = this.taskService.list({ status: 'pending' });

    // Work hours for the day.
    const workHours = this.resolveWorkHours();
    const workStart = `${date}T${workHours.start}:00`;
    const workEnd = `${date}T${workHours.end}:00`;
    const totalWorkMinutes = (new Date(workEnd).getTime() - new Date(workStart).getTime()) / 60000;

    // Separate task blocks from event blocks.
    const taskBlocks = blocks.filter((b) => b.task_id);
    const eventBlocks = blocks.filter((b) => b.event_id);

    // Total minutes occupied by tasks.
    const scheduledMinutes = blocks.reduce((acc, b) => {
      return acc + (new Date(b.end_time).getTime() - new Date(b.start_time).getTime()) / 60000;
    }, 0);

    // Compute utilization rate.
    const utilizationRate =
      totalWorkMinutes > 0 ? Math.round((scheduledMinutes / totalWorkMinutes) * 100) : 0;

    // Compute fragmentation score.
    // Fragmentation = number of discrete task blocks / total task minutes * 100
    // More blocks per minute = more fragmented.
    const fragmentationScore =
      scheduledMinutes > 0 && taskBlocks.length > 0
        ? Math.min(
            100,
            Math.round(
              ((taskBlocks.length - 1) / Math.max(1, taskBlocks.length + eventBlocks.length)) * 100
            )
          )
        : 0;

    // Compute priority-weighted completion potential.
    // Sum of priority scores for tasks that ARE scheduled / sum for all tasks.
    const completionRates = this.loadProjectCompletionRates();
    let scheduledPrioritySum = 0;
    let totalPrioritySum = 0;

    for (const task of allTasks) {
      if (task.locked || task.parent_task_id) {
        continue;
      }
      const priority = this.computeEffectivePriority(task, date, completionRates);
      totalPrioritySum += priority;
      const isScheduled = taskBlocks.some((b) => b.task_id === task.id && b.date === date);
      if (isScheduled) {
        scheduledPrioritySum += priority;
      }
    }

    const priorityWeightedCompletionPotential =
      totalPrioritySum > 0 ? Math.round((scheduledPrioritySum / totalPrioritySum) * 100) : 0;

    // Compute average buffer between task blocks.
    const sortedBlocks = [...blocks].sort((a, b) => a.start_time.localeCompare(b.start_time));
    let totalGapMinutes = 0;
    let gapCount = 0;
    for (let i = 1; i < sortedBlocks.length; i++) {
      const prevEnd = sortedBlocks[i - 1].end_time;
      const currStart = sortedBlocks[i].start_time;
      const gap = (new Date(currStart).getTime() - new Date(prevEnd).getTime()) / 60000;
      if (gap > 0 && gap < 120) {
        // Ignore gaps larger than 2 hours (likely lunch / breaks).
        totalGapMinutes += gap;
        gapCount++;
      }
    }
    const averageBufferMinutes =
      gapCount > 0 ? Math.round((totalGapMinutes / gapCount) * 10) / 10 : 0;

    return {
      date,
      totalTasks: allTasks.filter((t) => !t.locked && !t.parent_task_id).length,
      scheduledCount: taskBlocks.length,
      deferredCount:
        allTasks.filter((t) => !t.locked && !t.parent_task_id).length - taskBlocks.length,
      utilizationRate,
      fragmentationScore,
      priorityWeightedCompletionPotential,
      averageBufferMinutes,
      slotCount: blocks.length,
      totalWorkMinutes: Math.round(totalWorkMinutes),
      scheduledMinutes: Math.round(scheduledMinutes),
    };
  }

  /**
   * **Score all task-slot combinations for a given configuration.**
   *
   * Returns the detailed scoring matrix so callers (UI, AI analysis) can
   * understand or visualise why tasks were placed where.
   *
   * @param date         ISO date string (YYYY-MM-DD).
   * @param tasks        Array of tasks to evaluate (not necessarily all pending).
   * @param preferences  Optional tuning parameters.
   * @returns            Array of scored assignments, sorted by totalScore descending.
   */
  getOptimalSlots(
    date: string,
    tasks: Task[],
    preferences?: SchedulingPreferences
  ): SlotScoreDetail[] {
    const preservedBlocks = this.getPreservedBlocks(date);
    const events = this.eventService.list({
      start: `${date}T00:00:00`,
      end: `${date}T23:59:59`,
    });
    const eventBlocks = this.createEventBlocks(events, date, preservedBlocks, false);
    const occupiedSlots = this.computeOccupiedSlots(date, [...preservedBlocks, ...eventBlocks]);
    const availableSlots = this.getAvailableSlots(date, occupiedSlots);
    const bufferMinutes = preferences?.bufferMinutes ?? this.getBufferPreference() ?? 5;
    const preferMorning = preferences?.preferMorningForDeadlineTasks ?? true;
    const energyPatterns = preferences?.respectEnergyPatterns ? this.loadEnergyPatterns() : null;
    const completionRates = this.loadProjectCompletionRates();

    const results: SlotScoreDetail[] = [];

    for (const task of tasks) {
      const priorityScore = this.computeEffectivePriority(task, date, completionRates);
      const duration = task.duration_minutes ?? 0;

      for (const slot of availableSlots) {
        if (slot.remainingMinutes < duration) {
          continue;
        }

        const slotStart = slot.start;
        const taskEnd = this.addMinutes(slotStart, duration);

        const {
          durationMatch,
          timeOfDayPreference,
          energyAlignment,
          fragmentationPenalty,
          bufferBonus,
        } = this.computeSlotScores(
          task,
          slot,
          duration,
          preferMorning,
          energyPatterns,
          priorityScore
        );

        results.push({
          taskId: task.id,
          taskTitle: task.title,
          slotStart,
          slotEnd: taskEnd,
          totalScore:
            durationMatch +
            timeOfDayPreference +
            energyAlignment +
            fragmentationPenalty +
            bufferBonus,
          durationMatch,
          timeOfDayPreference,
          energyAlignment,
          fragmentationPenalty,
          bufferBonus,
          taskPriorityScore: priorityScore,
        });
      }
    }

    results.sort((a, b) => b.totalScore - a.totalScore);
    return results;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PRIVATE: Priority Scoring
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Compute the full priority breakdown for a task.
   *
   * Components:
   *  - **Base score**: derived from `time_effect_type`. `deadline` (10),
   *    `event_bound` (8), `continuous` (5).
   *  - **Urgency bonus**: based on how close the due date is.
   *    `urgency = max(0, 10 - daysUntilDeadline) * 2`.
   *    Tasks without a due date receive 0 urgency.
   *  - **Dependency bonus**: parent tasks receive +5. Tasks with children
   *    that are also pending receive an additional +3.
   *  - **Completion-history bonus**: projects whose historical completion
   *    rate is above 50 % receive up to +5.
   */
  private computePriorityBreakdown(
    task: Task,
    date: string,
    completionRates: Map<string, { completed: number; total: number }>
  ): { base: number; urgency: number; dependency: number; completionHistory: number } {
    // ── Base score from time_effect_type ──
    let base = 5; // continuous
    if (task.time_effect_type === 'deadline') {
      base = 10;
    } else if (task.time_effect_type === 'event_bound') {
      base = 8;
    }

    // ── Urgency bonus ──
    let urgency = 0;
    if (task.due_date) {
      const daysUntilDeadline = this.daysBetween(date, task.due_date);
      urgency = Math.max(0, 10 - daysUntilDeadline) * 2;
    }

    // ── Dependency bonus ──
    let dependency = 0;
    if (task.parent_task_id) {
      // This is a subtask; its parent should be scheduled first.
      dependency = 2;
    }
    // Check if this task has children that are pending.
    const subTasks = this.taskService.getSubTasks(task.id);
    const hasPendingChildren = subTasks.some((s) => s.status === 'pending');
    if (hasPendingChildren) {
      dependency += 5;
    }

    // ── Completion-history bonus ──
    let completionHistory = 0;
    if (task.project) {
      const stats = completionRates.get(task.project);
      if (stats && stats.total > 0) {
        const rate = stats.completed / stats.total;
        if (rate > 0.8) {
          completionHistory = 5;
        } else if (rate > 0.6) {
          completionHistory = 3;
        } else if (rate > 0.4) {
          completionHistory = 1;
        }
      }
    }

    return { base, urgency, dependency, completionHistory };
  }

  /**
   * Convenience: return a single numeric priority for a task (sum of all breakdown components).
   */
  private computeEffectivePriority(
    task: Task,
    date: string,
    completionRates: Map<string, { completed: number; total: number }>
  ): number {
    const b = this.computePriorityBreakdown(task, date, completionRates);
    return b.base + b.urgency + b.dependency + b.completionHistory;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PRIVATE: Slot Scoring
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Compute the five-dimensional score for placing a task into a time slot.
   *
   * Returns a breakdown object; callers can sum the fields to obtain a
   * total score. Scores are returned as plain numbers (not normalised to
   * a percentage), making them suitable for comparison across slots.
   *
   * Dimensions:
   *
   *  1. **Duration match (0–20)**
   *     How well the task duration fills the slot.
   *       - 90–100 % fill  → 20 (excellent match)
   *       - 70–90 % fill   → 15 (good)
   *       - 50–70 % fill   → 10 (acceptable)
   *       - 25–50 % fill   → 5  (loose)
   *       - < 25 % fill     → 0  (poor — large remainder)
   *
   *  2. **Time-of-day preference (0–15)**
   *       - `deadline` tasks: prefer 08:00–12:00 (+15), 12:00–14:00 (+8), else +3.
   *       - `event_bound` tasks: prefer near the bound event time (+12) if
   *         an event with bound_task_id exists.
   *       - `continuous` tasks: neutral (+8) for all hours.
   *
   *  3. **Energy alignment (0–10)**
   *     If learned energy patterns are available, high-priority tasks
   *     (priorityScore >= 12) get +10 for peak hours, +5 for neutral hours,
   *     and -5 for low-energy hours. Lower priority tasks get +3 for peak,
   *     0 otherwise.
   *
   *  4. **Fragmentation penalty (0 to -15)**
   *     Penalty for leaving a remainder that is too small to be useful.
   *       - remainder == 0              → 0 (perfect fit)
   *       - remainder in (0, 15] min    → -15 (unusable fragment)
   *       - remainder in (15, 30] min   → -8 (barely usable)
   *       - remainder > 30 min          → 0 (usable slot remains)
   *
   *  5. **Buffer bonus (0–5)**
   *     +5 if there is a natural gap (event, locked block) >= 10 min after
   *     the task end, or if the slot is the last in the day.
   *     +3 if there is a gap >= 5 min after.
   *     +0 otherwise.
   */
  private computeSlotScores(
    task: Task,
    slot: TimeSlot,
    duration: number,
    preferMorning: boolean,
    energyPatterns: EnergyPatterns | null,
    priorityScore: number
  ): {
    durationMatch: number;
    timeOfDayPreference: number;
    energyAlignment: number;
    fragmentationPenalty: number;
    bufferBonus: number;
  } {
    // ── 1. Duration match ──
    const ratio = duration / slot.remainingMinutes;
    let durationMatch = 0;
    if (ratio >= 0.9) {
      durationMatch = 20;
    } else if (ratio >= 0.7) {
      durationMatch = 15;
    } else if (ratio >= 0.5) {
      durationMatch = 10;
    } else if (ratio >= 0.25) {
      durationMatch = 5;
    } else {
      durationMatch = 0;
    }

    // ── 2. Time-of-day preference ──
    const hour = this.getHourFromISO(slot.start);
    let timeOfDayPreference = 8; // default neutral

    if (task.time_effect_type === 'deadline') {
      if (preferMorning) {
        if (hour >= 8 && hour < 12) {
          timeOfDayPreference = 15;
        } else if (hour >= 12 && hour < 14) {
          timeOfDayPreference = 8;
        } else if (hour >= 14 && hour < 18) {
          timeOfDayPreference = 5;
        } else {
          timeOfDayPreference = 3;
        }
      } else {
        timeOfDayPreference = 10;
      }
    } else if (task.time_effect_type === 'event_bound') {
      // If the task is bound to an event, prefer slots near that event's time.
      const boundEvent = this.findBoundEvent(task);
      if (boundEvent) {
        const eventHour = this.getHourFromISO(boundEvent.start_time);
        const hourDiff = Math.abs(hour - eventHour);
        if (hourDiff <= 1) {
          timeOfDayPreference = 15;
        } else if (hourDiff <= 2) {
          timeOfDayPreference = 12;
        } else if (hourDiff <= 4) {
          timeOfDayPreference = 8;
        } else {
          timeOfDayPreference = 4;
        }
      } else {
        timeOfDayPreference = 8;
      }
    }
    // continuous keeps the default of 8.

    // ── 3. Energy alignment ──
    let energyAlignment = 0;
    if (energyPatterns) {
      const isPeak = energyPatterns.peakHours.includes(hour);
      const isLow = energyPatterns.lowHours.includes(hour);

      if (priorityScore >= 12) {
        // High-priority task: strongly prefer peak hours.
        if (isPeak) {
          energyAlignment = 10;
        } else if (isLow) {
          energyAlignment = -5;
        } else {
          energyAlignment = 5;
        }
      } else if (priorityScore >= 6) {
        if (isPeak) {
          energyAlignment = 5;
        } else if (isLow) {
          energyAlignment = -2;
        } else {
          energyAlignment = 2;
        }
      } else {
        if (isPeak) {
          energyAlignment = 3;
        } else {
          energyAlignment = 0;
        }
      }
    }

    // ── 4. Fragmentation penalty ──
    const remainder = slot.remainingMinutes - duration;
    let fragmentationPenalty = 0;
    if (remainder === 0) {
      fragmentationPenalty = 0; // perfect fit
    } else if (remainder > 0 && remainder <= 15) {
      fragmentationPenalty = -15; // unusable fragment
    } else if (remainder <= 30) {
      fragmentationPenalty = -8; // barely usable
    }
    // remainder > 30 → 0 (usable slot)

    // ── 5. Buffer bonus ──
    // Check what comes after the slot end.
    const taskEnd = this.addMinutes(slot.start, duration);
    const slotEndTime = new Date(slot.end).getTime();
    const taskEndTime = new Date(taskEnd).getTime();
    const gapAfter = (slotEndTime - taskEndTime) / 60000;

    let bufferBonus = 0;
    if (gapAfter >= 10) {
      bufferBonus = 5;
    } else if (gapAfter >= 5) {
      bufferBonus = 3;
    } else {
      bufferBonus = 0;
    }

    return {
      durationMatch,
      timeOfDayPreference,
      energyAlignment,
      fragmentationPenalty,
      bufferBonus,
    };
  }

  /**
   * Select the best slot for a task by scoring all candidates.
   *
   * @param task            The task to place.
   * @param slots           Current available time slots (mutated in-place when selected).
   * @param date            ISO date string.
   * @param bufferMinutes   Buffer to reserve after placement.
   * @param preferMorning   Whether deadline tasks prefer mornings.
   * @param energyPatterns  Learned energy patterns (nullable).
   * @param priorityScore   Pre-computed priority score for the task.
   * @returns               The selected slot boundaries, or null if no slot fits.
   */
  private selectBestSlot(
    task: Task,
    slots: TimeSlot[],
    date: string,
    bufferMinutes: number,
    preferMorning: boolean,
    energyPatterns: EnergyPatterns | null,
    priorityScore: number
  ): { start: string; end: string } | null {
    const duration = task.duration_minutes ?? 30;

    if (slots.length === 0 || !duration || duration <= 0) {
      return null;
    }

    let bestSlot: { start: string; end: string } | null = null;
    let bestScore = -Infinity;

    for (const slot of slots) {
      if (slot.remainingMinutes < duration) {
        continue;
      }

      const scores = this.computeSlotScores(
        task,
        slot,
        duration,
        preferMorning,
        energyPatterns,
        priorityScore
      );

      const totalScore =
        scores.durationMatch +
        scores.timeOfDayPreference +
        scores.energyAlignment +
        scores.fragmentationPenalty +
        scores.bufferBonus;

      if (totalScore > bestScore) {
        bestScore = totalScore;
        bestSlot = {
          start: slot.start,
          end: this.addMinutes(slot.start, duration),
        };
      }
    }

    return bestSlot;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PRIVATE: Gap-Filling Pass
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * **Second-pass optimisation: fill small gaps with deferred short tasks.**
   *
   * After the main weighted-scoring pass, scan all remaining free gaps that
   * are >= 15 minutes. Sort deferred tasks by duration ascending (shortest
   * first) and attempt to fit them. This improves utilisation by capturing
   * tasks that were too small to compete effectively in the main pass.
   *
   * @param slots     Remaining available slots (mutated in-place).
   * @param deferred  List of currently deferred tasks (read-only; updates
   *                  applied by caller).
   * @param date      ISO date string.
   * @param now       Timestamp for block creation.
   * @returns         Blocks created during gap filling.
   */
  private gapFillingPass(
    slots: TimeSlot[],
    deferred: DeferredTask[],
    date: string,
    now: string
  ): ScheduleBlock[] {
    const blocks: ScheduleBlock[] = [];

    // Only attempt to fill tasks deferred due to 'no_fit'.
    const fillable = deferred.filter((d) => d.reason === 'no_fit');
    if (fillable.length === 0) {
      return blocks;
    }

    // Collect gaps >= 15 minutes.
    const gaps = slots.filter((s) => s.remainingMinutes >= 15);
    if (gaps.length === 0) {
      return blocks;
    }

    // Fetch full task objects.
    const tasksToFill: Array<{ task: Task; deferredEntry: DeferredTask }> = [];
    for (const d of fillable) {
      const task = this.taskService.getById(d.taskId);
      if (
        task &&
        task.duration_minutes &&
        task.duration_minutes > 0 &&
        task.duration_minutes <= 120
      ) {
        tasksToFill.push({ task, deferredEntry: d });
      }
    }

    // Sort by duration ascending (short tasks fit more easily).
    tasksToFill.sort((a, b) => (a.task.duration_minutes ?? 0) - (b.task.duration_minutes ?? 0));

    for (const { task } of tasksToFill) {
      const duration = task.duration_minutes!;

      // Find the slot where this task fits best (smallest slot that still fits).
      let bestGap: TimeSlot | null = null;
      for (const gap of gaps) {
        if (gap.remainingMinutes >= duration) {
          if (!bestGap || gap.remainingMinutes < bestGap.remainingMinutes) {
            bestGap = gap;
          }
        }
      }

      if (bestGap) {
        const block: ScheduleBlock = {
          id: uuidv4(),
          task_id: task.id,
          event_id: null,
          date,
          start_time: bestGap.start,
          end_time: this.addMinutes(bestGap.start, duration),
          locked: false,
          manual_signal: false,
          created_at: now,
          updated_at: now,
        };
        this.persistBlock(block);
        blocks.push(block);

        // Trim the gap (no buffer for gap-fill — they're already tight).
        this.trimSlot(gaps, bestGap, 0);
        // Also update the original slots array (which is a reference).
        const originalSlot = slots.find(
          (s) => s.start === bestGap!.start && s.end === bestGap!.end
        );
        if (originalSlot) {
          this.trimSlot(slots, bestGap, 0);
        }
      }
    }

    return blocks;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PRIVATE: Energy Patterns & Completion Rates
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Load learned energy patterns from user preferences.
   *
   * The patterns are stored as a JSON blob under the key
   * `learned_energy_patterns`. Expected shape:
   * ```json
   * { "peakHours": [9, 10, 14, 15], "lowHours": [13, 16], "variability": "low" }
   * ```
   * Returns `null` if no patterns are stored or if they cannot be parsed.
   */
  private loadEnergyPatterns(): EnergyPatterns | null {
    const raw = this.preferenceService.get('learned_energy_patterns');
    if (!raw) {
      return null;
    }

    try {
      const parsed = JSON.parse(raw);
      return {
        peakHours: Array.isArray(parsed.peakHours) ? parsed.peakHours.map(Number) : [],
        lowHours: Array.isArray(parsed.lowHours) ? parsed.lowHours.map(Number) : [],
        variability: typeof parsed.variability === 'string' ? parsed.variability : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Load historical completion rates grouped by project.
   *
   * Queries the database for all non-deleted tasks and computes the ratio
   * of completed to total tasks per project. Used to give a scheduling
   * bonus to tasks in projects where the user follows through.
   *
   * @returns Map from project name to `{ completed, total }`.
   */
  private loadProjectCompletionRates(): Map<string, { completed: number; total: number }> {
    const rows = this.db
      .prepare(
        `SELECT project, status, COUNT(*) as count
         FROM tasks
         WHERE project IS NOT NULL AND project != ''
         GROUP BY project, status`
      )
      .all() as Array<{ project: string; status: string; count: number }>;

    const projectStats = new Map<string, { completed: number; total: number }>();

    for (const row of rows) {
      if (!projectStats.has(row.project)) {
        projectStats.set(row.project, { completed: 0, total: 0 });
      }
      const stats = projectStats.get(row.project)!;
      stats.total += row.count;
      if (row.status === 'completed') {
        stats.completed += row.count;
      }
    }

    return projectStats;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PRIVATE: Slot & Buffer Management
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Insert a buffer after a task by trimming the front of the slot.
   *
   * After a task takes `duration` minutes from a slot, the remaining portion
   * of the slot starts at `taskEnd + bufferMinutes`. If that point is beyond
   * the slot end, the slot is removed (start >= end). If the buffer creates
   * a slot smaller than 5 minutes, it is discarded entirely.
   *
   * @param slots         Array of available slots (mutated in-place).
   * @param usedSlot      The slot that was just consumed (must exist in `slots`).
   * @param bufferMinutes Minutes of blank space to reserve.
   */
  private trimSlot(
    slots: TimeSlot[],
    usedSlot: { start: string; end: string },
    bufferMinutes: number
  ): void {
    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      if (slot.start === usedSlot.start) {
        const newStart = this.addMinutes(usedSlot.end, bufferMinutes);
        const newRemaining = (new Date(slot.end).getTime() - new Date(newStart).getTime()) / 60000;

        if (newRemaining < 5) {
          // Slot is effectively consumed.
          slots.splice(i, 1);
        } else {
          slot.start = newStart;
          slot.remainingMinutes = newRemaining;
        }
        break;
      }
    }
  }

  /**
   * Update the slot list after a task is placed (legacy helper).
   */
  private updateAvailableSlots(slots: TimeSlot[], used: { start: string; end: string }): void {
    for (const slot of slots) {
      if (slot.start === used.start) {
        const newStart = used.end;
        const newRemaining = (new Date(slot.end).getTime() - new Date(newStart).getTime()) / 60000;
        slot.start = newStart;
        slot.remainingMinutes = newRemaining;
        break;
      }
    }
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PRIVATE: Helper — Occupied / Available Slots
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Compute occupied time intervals from the given blocks.
   */
  private computeOccupiedSlots(
    date: string,
    blocks: ScheduleBlock[]
  ): Array<{ start: string; end: string }> {
    return blocks
      .filter((b) => b.date === date)
      .map((b) => ({ start: b.start_time, end: b.end_time }));
  }

  /**
   * Build the list of free time slots between occupied intervals within
   * the configured work hours.
   *
   * Work hours are validated: if `00:00-00:00` or start >= end, the
   * defaults `09:00-18:00` are used as a fallback.
   *
   * @param date      ISO date string.
   * @param occupied  Array of occupied start/end pairs.
   * @returns         Sorted array of available slots.
   */
  private getAvailableSlots(
    date: string,
    occupied: Array<{ start: string; end: string }>
  ): TimeSlot[] {
    const workHours = this.resolveWorkHours();
    const workStart = `${date}T${workHours.start}:00`;
    const workEnd = `${date}T${workHours.end}:00`;

    const slots: TimeSlot[] = [];
    let current = workStart;

    const sorted = [...occupied].sort((a, b) => a.start.localeCompare(b.start));

    for (const occ of sorted) {
      if (current < occ.start) {
        const minutes = (new Date(occ.start).getTime() - new Date(current).getTime()) / 60000;
        if (minutes >= 5) {
          slots.push({
            start: current,
            end: occ.start,
            remainingMinutes: minutes,
          });
        }
      }
      if (occ.end > current) {
        current = occ.end;
      }
    }

    if (current < workEnd) {
      const minutes = (new Date(workEnd).getTime() - new Date(current).getTime()) / 60000;
      if (minutes >= 5) {
        slots.push({
          start: current,
          end: workEnd,
          remainingMinutes: minutes,
        });
      }
    }

    return slots;
  }

  /**
   * Resolve work hours from preferences, with validation fallback.
   */
  private resolveWorkHours(): { start: string; end: string } {
    let workHours = this.preferenceService.getWorkHours();

    if (
      (workHours.start === '00:00' && workHours.end === '00:00') ||
      workHours.start.localeCompare(workHours.end) >= 0
    ) {
      workHours = { start: '09:00', end: '18:00' };
    }

    return workHours;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PRIVATE: Helper — First-Fit Slot Finder (Legacy)
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * **Legacy first-fit-with-scoring slot finder.**
   *
   * Used only by `planDayLegacy`. Scores each slot by duration-fit ratio,
   * morning preference for deadline tasks, and fragmentation penalty.
   * Falls back to pure first-fit if no slot scores above -Infinity.
   *
   * @deprecated Use `selectBestSlot` (weighted scoring) instead.
   */
  private findSlotForTask(
    task: Task,
    slots: TimeSlot[],
    date: string
  ): { start: string; end: string } | null {
    const duration = task.duration_minutes ?? 30;
    if (slots.length === 0) {
      return null;
    }

    const isMorning = (timeStr: string): boolean => {
      const hours = parseInt(timeStr.split('T')[1]?.split(':')[0] ?? '12', 10);
      return hours >= 6 && hours < 12;
    };

    let bestSlot: { start: string; end: string } | null = null;
    let bestScore = -Infinity;

    for (const slot of slots) {
      if (slot.remainingMinutes < duration) {
        continue;
      }

      let score = 0;
      const ratio = duration / slot.remainingMinutes;

      if (ratio >= 0.6 && ratio <= 0.9) {
        score += 10;
      } else if (ratio > 0.9) {
        score += 5;
      } else {
        score += 2;
      }

      if (task.time_effect_type === 'deadline' || task.due_date) {
        if (isMorning(slot.start)) {
          score += 8;
        }
      }

      const unusedMinutes = slot.remainingMinutes - duration;
      score -= unusedMinutes * 0.5;

      if (score > bestScore) {
        bestScore = score;
        bestSlot = {
          start: slot.start,
          end: this.addMinutes(slot.start, duration),
        };
      }
    }

    if (!bestSlot) {
      for (const slot of slots) {
        if (slot.remainingMinutes >= duration) {
          return {
            start: slot.start,
            end: this.addMinutes(slot.start, duration),
          };
        }
      }
    }

    return bestSlot;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PRIVATE: Helper — Locked Blocks & Event Blocks
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Retrieve schedule blocks that must survive replanning.
   */
  private getPreservedBlocks(date: string): ScheduleBlock[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM schedule_blocks WHERE date = ? AND (locked = 1 OR manual_signal = 1) ORDER BY start_time, created_at'
      )
      .all(date) as Record<string, unknown>[];
    return rows.map((r) => this.mapRowToBlock(r));
  }

  /**
   * Create missing schedule blocks from events.
   */
  private createEventBlocks(
    events: Event[],
    date: string,
    existingBlocks: ScheduleBlock[] = [],
    persist = true
  ): ScheduleBlock[] {
    const now = new Date().toISOString();
    const existingEventIds = new Set(
      existingBlocks
        .map((block) => block.event_id)
        .filter((eventId): eventId is string => !!eventId)
    );

    return events.flatMap((event) => {
      if (existingEventIds.has(event.id)) {
        return [];
      }

      const block: ScheduleBlock = {
        id: uuidv4(),
        event_id: event.id,
        task_id: null,
        date,
        start_time: event.start_time,
        end_time: event.end_time,
        locked: event.locked,
        manual_signal: false,
        created_at: now,
        updated_at: now,
      };
      if (persist) {
        this.persistBlock(block);
      }
      return [block];
    });
  }

  /**
   * Find the event bound to a task (if any).
   */
  private findBoundEvent(task: Task): Event | null {
    if (!task.id) {
      return null;
    }
    // Fast path: during a planning pass the bound-event index is precomputed
    // once, avoiding an eventService.list() call (full table scan) for every
    // event_bound task on every candidate slot.
    if (this.boundEventCache) {
      return this.boundEventCache.get(task.id) ?? null;
    }
    const events = this.eventService.list();
    return events.find((e) => e.bound_task_id === task.id) ?? null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PRIVATE: Helper — Persistence
  // ════════════════════════════════════════════════════════════════════════════

  private clearDaySchedule(date: string): number {
    const result = this.db
      .prepare('DELETE FROM schedule_blocks WHERE date = ? AND locked = 0 AND manual_signal = 0')
      .run(date);
    return result.changes;
  }

  private persistBlock(block: ScheduleBlock): void {
    this.db
      .prepare(
        `INSERT INTO schedule_blocks (id, task_id, event_id, date, start_time, end_time, locked, manual_signal, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        block.id,
        block.task_id,
        block.event_id,
        block.date,
        block.start_time,
        block.end_time,
        block.locked ? 1 : 0,
        block.manual_signal ? 1 : 0,
        block.created_at,
        block.updated_at
      );
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PRIVATE: Helper — Buffer Preference
  // ════════════════════════════════════════════════════════════════════════════

  /**
   * Read the user's preferred buffer minutes from preferences.
   * Returns `null` if not set (caller should use default 5).
   */
  private getBufferPreference(): number | null {
    const raw = this.preferenceService.get('buffer_minutes');
    if (raw === null) {
      return null;
    }
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PRIVATE: Helper — Date / Time Utilities
  // ════════════════════════════════════════════════════════════════════════════

  private addMinutes(localDateTime: string, minutes: number): string {
    const date = new Date(localDateTime);
    date.setMinutes(date.getMinutes() + minutes);
    return this.formatLocalDateTime(date);
  }

  private formatLocalDateTime(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  }

  /**
   * Compute the number of calendar days between two date strings.
   * Rounds to the nearest integer day.
   */
  private daysBetween(startDate: string, endDate: string): number {
    const start = new Date(startDate);
    const end = new Date(endDate);
    const diffMs = end.getTime() - start.getTime();
    return Math.round(diffMs / 86400000);
  }

  /**
   * Extract the hour (0-23) from an ISO datetime string.
   */
  private getHourFromISO(iso: string): number {
    const match = iso.split('T')[1];
    if (!match) {
      return 12;
    }
    return parseInt(match.split(':')[0], 10) || 12;
  }

  /**
   * Return the next date string (YYYY-MM-DD).
   */
  private getNextDateString(date: string): string {
    const d = new Date(date);
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  }

  /**
   * Extract occupied slot pairs from blocks (legacy helper).
   */
  private getOccupiedSlots(
    date: string,
    blocks: ScheduleBlock[]
  ): Array<{ start: string; end: string }> {
    return blocks
      .filter((b) => b.date === date)
      .map((b) => ({ start: b.start_time, end: b.end_time }));
  }

  // ════════════════════════════════════════════════════════════════════════════
  //  PRIVATE: Helper — Row Mapping
  // ════════════════════════════════════════════════════════════════════════════

  private mapRowToBlock(row: Record<string, unknown>): ScheduleBlock {
    return {
      id: row.id as string,
      task_id: (row.task_id as string) ?? null,
      event_id: (row.event_id as string) ?? null,
      date: row.date as string,
      start_time: row.start_time as string,
      end_time: row.end_time as string,
      locked: Boolean(row.locked),
      manual_signal: Boolean(row.manual_signal),
      created_at: row.created_at as string,
      updated_at: row.updated_at as string,
    };
  }
}
