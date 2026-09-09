import { defineConfig } from 'vitest/config';

// No container-backed behaviour exists here: `packages/styles` is pure CSS tokens plus stateless
// React primitives, with no I/O of any kind to stand a service up for. This config exists only so
// the workspace-inherited `test-integration` task (`.moon/tasks/all.yml`) has something to run;
// `passWithNoTests` keeps the empty suite green. Same shape as `packages/mailing`'s.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-integration/**/*.test.ts'],
    passWithNoTests: true,
  },
});
