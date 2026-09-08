import { defineConfig } from 'vitest/config';

// config's own mechanism (composeConfig et al.) is exercised fully by unit tests against
// in-memory ConfigSource stubs and the checked-in dotenv fixture — no container-backed behavior
// belongs to this package (ADR-0010). This config exists only so the workspace-inherited
// `test-integration` task has something to run; `passWithNoTests` keeps an empty suite green
// instead of erroring.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-integration/**/*.test.ts'],
    passWithNoTests: true,
  },
});
