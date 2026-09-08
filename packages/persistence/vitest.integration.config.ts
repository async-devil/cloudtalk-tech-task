import { defineConfig } from 'vitest/config';

// No container-backed migration/rows suite exists yet for this package (a Testcontainers Postgres
// suite is the natural next step once a real schema depends on this behavior end to end).
// `passWithNoTests` keeps the workspace-inherited `test-integration` task green until it lands,
// mirroring kernel/config.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-integration/**/*.test.ts'],
    passWithNoTests: true,
  },
});
