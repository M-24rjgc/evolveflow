import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { EvolveFlowDatabase } from '@evolveflow/storage';
import { ReminderService } from '../src/ReminderService.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

describe('ReminderService', () => {
  let db: EvolveFlowDatabase;
  let reminderService: ReminderService;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-test-'));
    db = new EvolveFlowDatabase(path.join(tmpDir, 'test.db'));
    reminderService = new ReminderService(db.getDb());
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should create a reminder', () => {
    const reminder = reminderService.create(null, null, '2025-06-01T10:00:00', 'Test reminder');

    expect(reminder.id.length).toBeGreaterThan(0);
    expect(reminder.status).toBe('pending');
  });

  it('should snooze a reminder', () => {
    const reminder = reminderService.create(null, null, '2025-06-01T10:00:00');
    const snoozed = reminderService.snooze(reminder.id, 30);

    expect(snoozed.status).toBe('snoozed');
    expect(snoozed.snoozed_until).not.toBeNull();
  });

  it('should dismiss a reminder', () => {
    const reminder = reminderService.create(null, null, '2025-06-01T10:00:00');
    const dismissed = reminderService.dismiss(reminder.id);

    expect(dismissed.status).toBe('dismissed');
  });
});
