import { defineConfig, mergeConfig } from 'vitest/config';
import rootConfig from '../vitest.config';

// Cross-package integration tests (domain + capabilities + storage together).
// These live at the repo root because they exercise multiple packages and
// don't belong to any single one.
export default mergeConfig(
  rootConfig,
  defineConfig({
    test: {
      include: ['run-all-tests.ts'],
    },
  })
);
