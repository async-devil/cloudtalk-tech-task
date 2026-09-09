import { defineConfig } from 'vitest/config';

// entities is pure declaration (entity schemas + closed vocabularies, ADR-0003) — no
// container-backed behavior to integration-test. This config exists only so the workspace-inherited
// `test-integration` task (`.moon/tasks/all.yml`) has something to run; `passWithNoTests` keeps an
// empty suite green instead of erroring (mirrors kernel/contracts).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-integration/**/*.test.ts'],
    passWithNoTests: true,
  },
});
