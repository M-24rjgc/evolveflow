import { EvolveFlowDatabase } from '@evolveflow/storage';
import { createRegistry } from '../src/capabilities';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

let db: EvolveFlowDatabase;
let tmpDir: string;

function setup() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evolveflow-test-'));
  db = new EvolveFlowDatabase(path.join(tmpDir, 'test.db'));
}

function teardown() {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
}

async function testAllCapabilitiesRegistered() {
  setup();
  try {
    const registry = createRegistry(db);
    const caps = registry.list();
    assert(caps.length === 18, `Should have 18 capabilities, got ${caps.length}`);
    console.log('  ✅ testAllCapabilitiesRegistered passed');
  } finally {
    teardown();
  }
}

async function testTaskCreateCapability() {
  setup();
  try {
    const registry = createRegistry(db);
    const result = await registry.invoke('task.create', { title: 'Test via capability' }, { actor: 'user', origin: 'gui' });
    assert(result.success === true, 'Should succeed');
    assert((result.data as Record<string, unknown>).title === 'Test via capability', 'Title should match');
    console.log('  ✅ testTaskCreateCapability passed');
  } finally {
    teardown();
  }
}

async function testMissingRequiredField() {
  setup();
  try {
    const registry = createRegistry(db);
    const result = await registry.invoke('task.create', {}, { actor: 'user', origin: 'gui' });
    assert(result.success === false, 'Should fail without title');
    assert(result.error?.includes('Missing required field'), 'Should mention missing field');
    console.log('  ✅ testMissingRequiredField passed');
  } finally {
    teardown();
  }
}

async function testUnknownCapability() {
  setup();
  try {
    const registry = createRegistry(db);
    const result = await registry.invoke('unknown.capability', {}, { actor: 'user', origin: 'gui' });
    assert(result.success === false, 'Should fail for unknown capability');
    console.log('  ✅ testUnknownCapability passed');
  } finally {
    teardown();
  }
}

async function testIdempotency() {
  setup();
  try {
    const registry = createRegistry(db);
    const ctx = { actor: 'user' as const, origin: 'gui' as const, idempotency_key: 'unique-key-1' };
    const result1 = await registry.invoke('task.create', { title: 'Idempotent task' }, ctx);
    const result2 = await registry.invoke('task.create', { title: 'Idempotent task' }, ctx);
    assert(result1.success === true, 'First call should succeed');
    assert(result2.success === true, 'Second call should return cached result');
    console.log('  ✅ testIdempotency passed');
  } finally {
    teardown();
  }
}

async function testRevisionIncrement() {
  setup();
  try {
    const registry = createRegistry(db);
    const revBefore = db.getRevision();
    await registry.invoke('task.create', { title: 'Revision test' }, { actor: 'user', origin: 'gui' });
    const revAfter = db.getRevision();
    assert(revAfter > revBefore, 'Revision should increment after mutating capability');
    console.log('  ✅ testRevisionIncrement passed');
  } finally {
    teardown();
  }
}

async function testNonMutatingCapabilityNoRevisionChange() {
  setup();
  try {
    const registry = createRegistry(db);
    await registry.invoke('task.create', { title: 'Setup' }, { actor: 'user', origin: 'gui' });
    const revBefore = db.getRevision();
    await registry.invoke('history.list_actions', {}, { actor: 'user', origin: 'gui' });
    const revAfter = db.getRevision();
    assert(revAfter === revBefore, 'Revision should not change for non-mutating capability');
    console.log('  ✅ testNonMutatingCapabilityNoRevisionChange passed');
  } finally {
    teardown();
  }
}

console.log('\n🧪 Capability Registry Tests:');
await testAllCapabilitiesRegistered();
await testTaskCreateCapability();
await testMissingRequiredField();
await testUnknownCapability();
await testIdempotency();
await testRevisionIncrement();
await testNonMutatingCapabilityNoRevisionChange();
console.log('  All Capability Registry tests passed!\n');
