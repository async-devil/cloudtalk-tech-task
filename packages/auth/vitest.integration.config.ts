import { defineConfig } from 'vitest/config';

// The Testcontainers postgres:18 suite: magic-link sign-up via the stub
// mailer, disabled-method rejection, boot parity, the session middleware's forged-claim/no-membership
// paths, and the retention pass. Redis is not needed (better-auth is Postgres-only; retention is
// tested via purgeExpiredAuthRows directly, not the scheduler).
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test-integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
  },
});
