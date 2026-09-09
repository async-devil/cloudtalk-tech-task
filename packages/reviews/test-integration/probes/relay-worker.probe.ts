/**
 * A standalone `bun` OS process — never imported by a test file, only spawned — that runs the
 * reviews rating-aggregation outbox relay against a REAL Postgres + Redis (env `DATABASE_URL`,
 * `REDIS_URL`). Spawned by `outbox-relay-durability.test.ts`'s kill-and-restart proof, following
 * `packages/messaging/test-integration/harness/spawn-probe.ts`'s pattern: this suite's own Vitest
 * worker is real Node regardless of how `vitest` itself was launched, and the code under test
 * reaches for Bun's own globals (`@repo/persistence`/`@repo/messaging`), so it has to run as a
 * genuine `bun` process rather than merely be imported here.
 *
 * Env: `DATABASE_URL`, `REDIS_URL`, `TARGET_PRODUCT_ID` (the row the harness watches for),
 * `HOLD_MS` (how long `apply` holds AFTER recomputing that one product; default 5000).
 *
 * Prints exactly one JSON line — `{"event":"applied-target","reviewCount":<n>}` — the INSTANT the
 * target product's recompute has WRITTEN `reviews.product_rating` (`recomputeProductRating`'s own
 * `INSERT ... ON CONFLICT ... RETURNING` has resolved), then holds for `HOLD_MS` before returning
 * from `apply`. The harness sends `SIGKILL` the moment that line appears on stdout: the kill lands
 * provably AFTER the recompute's write executed and BEFORE `relayOutboxBatch`'s own claim
 * transaction ever reaches its commit (nothing between the print and the kill touches that
 * transaction) — the load-bearing timing fact "mid-recompute" is asserting.
 *
 * Never exits on its own; the harness's `SIGKILL` is the only way this process ends.
 */
import process from 'node:process';
import { startOutboxRelay } from '@repo/jobs';
import { createDb } from '@repo/persistence';
import { REVIEWS_OUTBOX, recomputeProductRating } from '@repo/reviews';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const targetProductId = process.env.TARGET_PRODUCT_ID;
const holdMs = Number(process.env.HOLD_MS ?? '5000');

if (databaseUrl === undefined || redisUrl === undefined || targetProductId === undefined) {
  throw new Error(
    'relay-worker.probe: DATABASE_URL, REDIS_URL and TARGET_PRODUCT_ID are all required',
  );
}

const db = createDb<unknown>({ connectionString: databaseUrl, poolSize: 3 });

await startOutboxRelay({
  db,
  outbox: REVIEWS_OUTBOX,
  connection: { redisUrl },
  everyMs: 200,
  batchSize: 5,
  apply: async (row) => {
    const result = await recomputeProductRating(db, row.aggregateId, {
      outboxRowCreatedAt: row.createdAt,
    });
    if (row.aggregateId === targetProductId) {
      process.stdout.write(
        `${JSON.stringify({ event: 'applied-target', reviewCount: result.reviewCount })}\n`,
      );
      await new Promise((resolve) => setTimeout(resolve, holdMs));
    }
  },
});

// Keeps the event loop alive — the harness's SIGKILL is the only way this process ends.
await new Promise(() => undefined);
