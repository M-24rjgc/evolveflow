export class DailySummaryScheduler {
  private timerId: ReturnType<typeof setInterval> | null = null;
  private onTrigger: ((date: string) => void) | null = null;

  constructor(onTrigger?: (date: string) => void) {
    if (onTrigger) this.onTrigger = onTrigger;
  }

  start(): void {
    this.timerId = setInterval(() => {
      const now = new Date();
      if (now.getHours() === 23 && now.getMinutes() === 0) {
        const date = now.toISOString().split('T')[0];
        if (this.onTrigger) {
          this.onTrigger(date);
        }
      }
    }, 60000);
  }

  stop(): void {
    if (this.timerId) {
      clearInterval(this.timerId);
      this.timerId = null;
    }
  }

  setOnTrigger(callback: (date: string) => void): void {
    this.onTrigger = callback;
  }
}