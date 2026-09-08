import { defineConfig } from 'vitest/config';

// The Testcontainers postgres:18 suite: package-local
// helper-level proofs (claim/regression-guard/write-ahead-conflict/completeBranch-count) so
// spine bugs surface here, not only through the example-context acceptance suite.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
