export class DailySummaryScheduler {
  private timerId: ReturnType<typeof setInterval> | null = null;
  private onTrigger: ((date: string) => void) | null = null;
  private lastTriggeredDate: string | null = null;
  private started: boolean = false;

  constructor(onTrigger?: (date: string) => void) {
    if (onTrigger) {this.onTrigger = onTrigger;}
  }

  start(): void {
    if (this.started) {
      throw new Error('DailySummaryScheduler has already been started. Call stop() first before restarting.');
    }
    this.started = true;

    this.timerId = setInterval(() => {
      const now = new Date();
      const todayStr = now.toISOString().split('T')[0];

      // Prevent multiple firings at the same time on the same day
      if (this.lastTriggeredDate === todayStr) {
        return;
      }

      if (now.getHours() === 23 && now.getMinutes() === 0) {
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
    }, 60000);
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
