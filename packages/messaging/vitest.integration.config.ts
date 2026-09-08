import { defineConfig } from 'vitest/config';

// The container-backed Redis suite (Testcontainers) is 's deliverable — the
// unit suite here is deliberately Redis-free ('s "pure logic" unit plan).
// `passWithNoTests` keeps the workspace-inherited `test-integration` task green until it lands,
// mirroring persistence/kernel/config.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-integration/**/*.test.ts'],
    passWithNoTests: true,
  },
});
