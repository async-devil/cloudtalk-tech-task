import { defineConfig } from 'vitest/config';

// The correlated-triple proof over a real OTLP receiver belongs to apps/api's own integration
// suite, since it needs the whole slice (edge + this facade), not this package alone. This config
// exists so the workspace-inherited `test-integration` task has something to run.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-integration/**/*.test.ts'],
    passWithNoTests: true,
  },
});
