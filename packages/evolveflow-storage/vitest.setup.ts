import { mkdtempSync, existsSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * Global test setup for @evolveflow/storage package.
 *
 * Creates a temporary directory for test databases so that each test run
 * starts with a clean filesystem environment.  The path is exposed via
 * EVOLVEFLOW_STORAGE_TEST_DIR so that individual test suites can create
 * their own databases inside it.
 */

const testDir = mkdtempSync(join(tmpdir(), 'evolveflow-storage-test-'));

if (!existsSync(testDir)) {
  mkdirSync(testDir, { recursive: true });
}

process.env.EVOLVEFLOW_STORAGE_TEST_DIR = testDir;

// Log the temporary directory so tests can reference it
console.log(`[vitest.setup] Storage test directory: ${testDir}`);
