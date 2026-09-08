import { defineConfig } from 'vitest/config';

// contracts has no container-backed dependency of its own; this file exists only so the
// workspace-inherited `test-integration` task (which every project gets) stays green rather than
// erroring on a missing config.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-integration/**/*.test.ts'],
    passWithNoTests: true,
  },
});
