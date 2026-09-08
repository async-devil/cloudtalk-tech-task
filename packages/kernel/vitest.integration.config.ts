import { defineConfig } from 'vitest/config';

// kernel is pure logic (errors + types) — it has no container-backed behavior to integration-test
// (ADR-0005's Testcontainers suites belong to persistence/messaging/apps-api). This config exists
// only so the workspace-inherited `test-integration` task (`.moon/tasks/all.yml`) has something to
// run; `passWithNoTests` keeps an empty suite green instead of erroring.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-integration/**/*.test.ts'],
    passWithNoTests: true,
  },
});
