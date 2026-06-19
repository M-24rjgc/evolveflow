export class DailySummaryScheduler {
  private timerId: ReturnType<typeof setInterval> | null = null;
  private onTrigger: ((date: string) => void) | null = null;
  private lastTriggeredDate: string | null = null;
  private started: boolean = false;
  private readonly triggerHour: number;
  private readonly triggerMinute: number;
  private readonly intervalMs: number;

  constructor(
    onTrigger?: (date: string) => void,
    options?: { triggerHour?: number; triggerMinute?: number; intervalMs?: number }
  ) {
    if (onTrigger) {
      this.onTrigger = onTrigger;
    }
    this.triggerHour = options?.triggerHour ?? 23;
    this.triggerMinute = options?.triggerMinute ?? 0;
    this.intervalMs = options?.intervalMs ?? 60000;
  }

  start(): void {
    if (this.started) {
      throw new Error(
        'DailySummaryScheduler has already been started. Call stop() first before restarting.'
      );
    }
    this.started = true;

    this.timerId = setInterval(() => {
      this.evaluate();
    }, this.intervalMs);
    // Run one evaluation immediately so a process that starts after the
    // trigger time can still fire the same day.
    this.evaluate();
  }

  private evaluate(): void {
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    // Prevent multiple firings on the same day.
    if (this.lastTriggeredDate === todayStr) {
      return;
    }

    // Compute today's trigger instant in local time. Once `now` has passed it,
    // fire. This means a process that was down during the exact trigger minute
    // (e.g. 23:00) but is running later (23:05, or even next morning before
    // midnight) will still fire for the intended day instead of silently
    // skipping it forever.
    const triggerTime = new Date(now);
    triggerTime.setHours(this.triggerHour, this.triggerMinute, 0, 0);

    if (now.getTime() >= triggerTime.getTime()) {
      this.lastTriggeredDate = todayStr;
      const date = todayStr;
      if (this.onTrigger) {
        try {
          this.onTrigger(date);
        } catch (err) {
          console.error('Daily summary trigger failed:', err);
        }
      }
    }
  }

  stop(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
    this.started = false;
  }

  setOnTrigger(callback: (date: string) => void): void {
    this.onTrigger = callback;
  }
}
