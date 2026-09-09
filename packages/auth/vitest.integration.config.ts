import { defineConfig } from 'vitest/config';

// The Testcontainers postgres:18 suite this package wants: magic-link sign-up via the stub
// mailer, disabled-method rejection, boot parity, the session middleware's forged-claim/
// no-membership paths, and the retention pass. Redis is not needed (better-auth is Postgres-only;
// retention is tested via purgeExpiredAuthRows directly, not the scheduler).
//
// It does not exist yet, though (review, 2026-09-09): no `test-integration/` directory has ever
// landed in this package, so `include` matches nothing. Every sibling package in this state
// (kernel/config/persistence/entities/styles/contracts) sets `passWithNoTests` for exactly that
// reason; this config was missing it, so the workspace-inherited `test-integration` task — which
// runs under CI's hard-fail-on-no-Docker branch (`run-integration-suite.ts`) — was hitting
// vitest's own "No test files found" failure (exit 1) instead, unconditionally, Docker or not.
// `passWithNoTests` restores the same "green until it lands" contract every other empty package
// gets; writing the suite the comment above describes is separate, real work (this package's own
// container-backed proof, not a CI-fix side effect).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    passWithNoTests: true,
  },
});
