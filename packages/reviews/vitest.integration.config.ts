import { defineConfig } from 'vitest/config';

// The Testcontainers postgres:18 suite: proves TASK-0002's container-only criteria — submitReview's
// outbox invariant, idempotent replay, and the drop-and-rebuild proof for reviews.product_rating —
// written by another engineer against this package's src/.
//
// `resolve.conditions` + `server.deps.inline` are the same fix `packages/jobs/vitest.integration.config.ts`
// carries, for the same reason (review, 2026-09-09): `run-integration-suite.ts` runs this suite
// under Bun (`bun node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts`), and
// every test file here imports `@repo/entities`' zod row schemas at module scope (this package's own
// `src/internal/rows.ts` does too). Left unpinned, Bun's own `bun` export condition resolves zod 4's
// raw TypeScript entry instead of its published ESM build, vitest's transform hands that back with
// no named exports initialized, and every suite dies at import time with `z.object is not an
// object` before a single test runs — CI's exact failure mode, reproduced locally with `bun
// node_modules/vitest/vitest.mjs run --config vitest.integration.config.ts` (no Docker needed to
// see it: it never gets past module eval).
export default defineConfig({
  resolve: {
    conditions: ['import', 'default'],
  },
  test: {
    environment: 'node',
    include: ['test-integration/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    server: {
      deps: { inline: [/zod/] },
    },
  },
});
