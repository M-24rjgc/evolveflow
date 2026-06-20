export default [
  // Per-package unit tests. Listed explicitly to exclude vendored third-party
  // packages (evolveflow-vendor-pi-*); their test suites belong to upstream
  // and aren't part of EvolveFlow's quality gate.
  'packages/evolveflow-storage/vitest.config.ts',
  'packages/evolveflow-domain/vitest.config.ts',
  'packages/evolveflow-capabilities/vitest.config.ts',
  'packages/evolveflow-runtime/vitest.config.ts',
  'packages/evolveflow-cli/vitest.config.ts',
  'packages/evolveflow-pi-bridge/vitest.config.ts',
  // Cross-package integration tests at the repo root.
  'tests/vitest.config.ts',
];
