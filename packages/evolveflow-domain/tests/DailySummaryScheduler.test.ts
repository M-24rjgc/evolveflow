import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DailySummaryScheduler } from '../src/DailySummaryScheduler.js';

describe('DailySummaryScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires when started after the trigger time has already passed (missed-window recovery)', () => {
    // Regression: previously the scheduler only fired during the exact minute
    // 23:00. If the process was down or busy during that minute, the day was
    // silently skipped. Now it fires once `now >= triggerTime` for the day.
    //
    // Use a deterministic system date: 23:42 local, well past the 23:00 window.
    vi.setSystemTime(new Date(2026, 5, 18, 23, 42, 0));

    const triggered: string[] = [];
    const scheduler = new DailySummaryScheduler((date) => {
      triggered.push(date);
    });

    scheduler.start();
    // start() now evaluates immediately.
    expect(triggered).toHaveLength(1);
    scheduler.stop();
  });

  it('does not fire twice on the same day', () => {
    vi.setSystemTime(new Date(2026, 5, 18, 23, 5, 0));

    const triggered: string[] = [];
    const scheduler = new DailySummaryScheduler((date) => {
      triggered.push(date);
    });
    scheduler.start();
    expect(triggered).toHaveLength(1);

    // Advance several intervals past the trigger window on the same day.
    vi.setSystemTime(new Date(2026, 5, 18, 23, 59, 0));
    vi.advanceTimersByTime(120000);
    vi.advanceTimersByTime(120000);

    expect(triggered).toHaveLength(1);
    scheduler.stop();
  });

  it('does not fire before the trigger time, then fires once it passes', () => {
    vi.setSystemTime(new Date(2026, 5, 18, 8, 0, 0));

    const triggered: string[] = [];
    const scheduler = new DailySummaryScheduler((date) => {
      triggered.push(date);
    });
    scheduler.start();
    expect(triggered).toHaveLength(0);

    // Still before 23:00 — must not fire.
    vi.setSystemTime(new Date(2026, 5, 18, 22, 30, 0));
    vi.advanceTimersByTime(120000);
    expect(triggered).toHaveLength(0);

    // Cross the trigger time — now it fires.
    vi.setSystemTime(new Date(2026, 5, 18, 23, 30, 0));
    vi.advanceTimersByTime(120000);
    expect(triggered).toHaveLength(1);
    scheduler.stop();
  });
});
