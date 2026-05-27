import { EvolveFlowDatabase } from '@evolveflow/storage';
import { ReminderService } from '../src/ReminderService.js';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

let db: EvolveFlowDatabase;
let reminderService: ReminderService;
let tmpDir: string;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-test-'));
  db = new EvolveFlowDatabase(path.join(tmpDir, 'test.db'));
  reminderService = new ReminderService(db.getDb());
}

function teardown() {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

function testCreateReminder() {
  setup();
  try {
    const reminder = reminderService.create(null, null, '2025-06-01T10:00:00', 'Test reminder');
    assert(reminder.id.length > 0, 'Should have an id');
    assert(reminder.status === 'pending', 'Should be pending');
    console.log('  ✅ testCreateReminder passed');
  } finally {
    teardown();
  }
}

function testSnoozeReminder() {
  setup();
  try {
    const reminder = reminderService.create(null, null, '2025-06-01T10:00:00');
    const snoozed = reminderService.snooze(reminder.id, 30);
    assert(snoozed.status === 'snoozed', 'Should be snoozed');
    assert(snoozed.snoozed_until !== null, 'Should have snoozed_until');
    console.log('  ✅ testSnoozeReminder passed');
  } finally {
    teardown();
  }
}

function testDismissReminder() {
  setup();
  try {
    const reminder = reminderService.create(null, null, '2025-06-01T10:00:00');
    const dismissed = reminderService.dismiss(reminder.id);
    assert(dismissed.status === 'dismissed', 'Should be dismissed');
    console.log('  ✅ testDismissReminder passed');
  } finally {
    teardown();
  }
}

console.log('\n🧪 ReminderService Tests:');
testCreateReminder();
testSnoozeReminder();
testDismissReminder();
console.log('  All ReminderService tests passed!\n');
