import { defineConfig } from 'vitest/config';

// No container-backed suite exists here, and none is planned: this project's integration-level
// proof is the Playwright e2e, which drives a real browser against a real api and lives outside
// vitest entirely. This config exists only so the workspace-inherited `test-integration` task
// (`.moon/tasks/all.yml`) has something to run; `passWithNoTests` keeps the empty suite green.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['test-integration/**/*.test.{ts,tsx}'],
    passWithNoTests: true,
  },
});
