import { defineConfig } from 'vitest/config';

// The container-backed suite convention is 's deliverable (spec -11.4): container-
// backed integration tests live under `test/` with an `*.itest.ts` suffix (not `*.test.ts`)
// deliberately: apps/api's unit `vitest.config.ts` includes `test/**/*.test.ts`, and these suites
// live under the same `test/` directory (touch-only constraint, brief) — a shared
// `.test.ts` suffix would make the unit runner pick these up too and try to spawn
// Testcontainers/the real entry with no harness bootstrapping. The distinct suffix is the whole
// separation mechanism; `apps/api/test/env-drift.test.ts` and
// `apps/api/test/boot-fail-closed.test.ts` are deliberately *unit*-level suites instead (no
// containers) and keep the ordinary `.test.ts` suffix so the unit runner picks them up as
// intended.
//
// retired the slice_notes demo flow and, with it, this app's only `*.itest.ts` files
// (`slice.e2e.itest.ts`, `observability.itest.ts`, and their shared Testcontainers harness) —
// `passWithNoTests` (below) keeps this task green with zero matching files until the next
// container-backed suite lands. `packages/reviews/test-integration/` is where
// the durability-spine container proofs live now.
//
// ADR-0010: container suites share infra per file (each suite's own `beforeAll` starts its own
// containers) — forks pool + no file parallelism keep concurrently-running suite files from
// starving each other's Docker/port budget; generous hook/test timeouts absorb first-run image
// pulls and (locally) colima's port-forwarder latency.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.itest.ts'],
    passWithNoTests: true,
    pool: 'forks',
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
