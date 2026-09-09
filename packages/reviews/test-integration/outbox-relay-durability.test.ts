/**
 * TASK-0005 / SPEC-0004's five durability proofs for the reviews rating-aggregation outbox relay
 * — restated in SPEC-0004's own words ("What the tests must prove"):
 *
 *   1. Replaying a delivered outbox row leaves `product_rating` identical apart from `computed_at`.
 *   2. Killing the relay process mid-recompute and restarting it converges.
 *   3. Flushing Redis loses no work: pending rows are still in Postgres, and the re-registered
 *      schedule drains them.
 *   4. A row whose application always throws is parked `dead` after exactly `maxAttempts` and
 *      retries no further.
 *   5. The lag instrument records a value on every pass.
 *
 * Needs BOTH Postgres (`./harness/postgres-container.js`, this package's own — TASK-0002) and Redis
 * (`./harness/redis-container.js`, new for this task, following `packages/messaging/
 * test-integration/harness/redis-container.ts`'s pattern) — only proofs 2 and 3 actually touch
 * Redis, but sharing one container pair for the whole file (rather than a second `beforeAll`) is
 * what every sibling suite in this tree already does.
 *
 * HONESTY NOTE, read before trusting a green run of this file: this environment cannot pull Docker
 * images, so none of these tests have actually been RUN — only written, typechecked (via the
 * throwaway `tsconfig` this change's verification instructions call for) and reasoned through by
 * hand. Every mutation comment below states what a reviewer should apply, watch go red, and
 * restore, per ADR-0010 — none of those mutations were executed here either, for the same reason.
 *
 * PROOF 4 UPDATE (2026-09-09 ruling): SPEC-0004's Retention/telemetry table says a parked outbox
 * row gets "a `jobs.dead_letter` row... written for triage". That used to be a gap this package
 * could only half-prove: `relayOutboxBatch` itself didn't write the row, the composition root
 * closed the gap instead (`apps/api/src/runtime/reviews-rating-worker.ts`'s now-deleted
 * `createReviewsRelayApply`), and this package cannot depend on an app to exercise it (ADR-0001
 * tier order). That gap is gone: `@repo/jobs`'s `relayOutboxBatch` now writes the triage row itself
 * (`writeOutboxDeadLetter`, `packages/jobs/src/dead-letter.ts`), inside its own claim transaction,
 * with no `PipelineTableContract` and no composition-root involvement — so proof 4 below asserts
 * the `jobs.dead_letter` row directly, using nothing this package doesn't already import.
 */

import { fileURLToPath } from 'node:url';
import {
  type Attributes,
  type Counter,
  type Gauge,
  type Histogram,
  type Meter,
  type MeterProvider,
  metrics,
  type UpDownCounter,
} from '@opentelemetry/api';
import { OUTBOX_ROW_STATUS } from '@repo/entities';
import { type OutboxRow, relayOutboxBatch, startOutboxRelay } from '@repo/jobs';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REVIEWS_OUTBOX, recomputeProductRating, submitReview } from '../src/index.js';
import {
  createAppUser,
  createTestProduct,
  type ReviewsTestInfra,
  startReviewsTestInfra,
} from './harness/postgres-container.js';
import { type RedisInfra, startRedisInfra } from './harness/redis-container.js';
import { lastJsonLine, runProbeUntilMarker } from './harness/spawn-relay-probe.js';

const RELAY_PROBE_SCRIPT = fileURLToPath(
  new URL('./probes/relay-worker.probe.ts', import.meta.url),
);

// ---------------------------------------------------------------------------------------------
// A live meter recorder, following `apps/api/test/health-routes.test.ts`'s own pattern exactly
// (its header explains WHY: `createModuleHistogram`/`createModuleCounter` resolve the underlying
// OTel instrument LAZILY, on first use, off the global meter provider — so the recorder must be
// registered ONCE, at module scope, before any test in this FILE's own module registry makes a
// call that could bind the real (no-op) default provider first). Every module's instruments share
// ONE OTel meter name (`@repo/observability`'s `METER_NAME`), so this also captures `@repo/jobs`'s
// own `jobs.outbox.*` instruments fired by `relayOutboxBatch`/`startOutboxRelay` in this file —
// harmless; proof 5 below filters to `reviews.rating.lag` by name.
// ---------------------------------------------------------------------------------------------

interface RecordedMetric {
  readonly name: string;
  readonly value: number;
  readonly attributes: Attributes | undefined;
}

function noopObservable() {
  return { addCallback: () => undefined, removeCallback: () => undefined };
}

const meterRecords: RecordedMetric[] = [];
const recordingMeter: Meter = {
  createHistogram: (name): Histogram => ({
    record: (value, attributes) => {
      meterRecords.push({ name, value, attributes });
    },
  }),
  createCounter: (name): Counter => ({
    add: (value, attributes) => {
      meterRecords.push({ name, value, attributes });
    },
  }),
  createUpDownCounter: (): UpDownCounter => ({ add: () => undefined }),
  createGauge: (): Gauge => ({ record: () => undefined }),
  createObservableGauge: noopObservable,
  createObservableCounter: noopObservable,
  createObservableUpDownCounter: noopObservable,
  addBatchObservableCallback: () => undefined,
  removeBatchObservableCallback: () => undefined,
};
const recordingProvider: MeterProvider = { getMeter: () => recordingMeter };
const registered = metrics.setGlobalMeterProvider(recordingProvider);
if (!registered) {
  throw new Error(
    'outbox-relay-durability.test.ts: a global MeterProvider was already registered — this suite ' +
      "needs to be the first to touch this module registry's lazily-resolved instruments",
  );
}

// ---------------------------------------------------------------------------------------------

interface ProductRatingRow {
  readonly review_count: number;
  readonly rating_average: string | null;
  readonly computed_at: Date;
}

async function fetchProductRating(
  db: Kysely<unknown>,
  productId: string,
): Promise<ProductRatingRow | undefined> {
  const result = await sql`
    SELECT review_count, rating_average, computed_at
    FROM reviews.product_rating WHERE product_id = ${productId}
  `.execute(db);
  return result.rows[0] as ProductRatingRow | undefined;
}

interface OutboxRowStatus {
  readonly status: number;
  readonly attempts: number;
}

async function fetchOutboxStatus(db: Kysely<unknown>, productId: string): Promise<OutboxRowStatus> {
  const result = await sql`
    SELECT outbox_row_status_id, attempts FROM reviews.outbox WHERE aggregate_id = ${productId}
  `.execute(db);
  const row = result.rows[0] as { outbox_row_status_id: number; attempts: number };
  return { status: row.outbox_row_status_id, attempts: row.attempts };
}

interface DeadLetterRow {
  readonly pipeline: string;
  readonly stage: string;
  readonly reason: string;
  readonly attempts: number;
}

/** `REVIEWS_OUTBOX` (`{ schema: 'reviews', table: 'outbox' }`) never sets
 * `OutboxRelayOptions.pipeline`, so `relayOutboxBatch` defaults it to `outbox.schema` — `'reviews'`
 * — exactly SPEC-0004's own words ("pipeline `reviews`"). */
async function fetchDeadLetterRows(
  db: Kysely<unknown>,
  productId: string,
): Promise<DeadLetterRow[]> {
  const result = await sql`
    SELECT pipeline, stage, reason, attempts FROM jobs.dead_letter
    WHERE pipeline = 'reviews' AND instance_id = ${productId}::uuid
    ORDER BY dead_letter_id
  `.execute(db);
  return result.rows as DeadLetterRow[];
}

/** `relayOutboxBatch`/`startOutboxRelay` both type `apply` as `(row: OutboxRow) => Promise<void>` —
 * an explicit `async` body with no `return` (rather than a bare arrow returning
 * `recomputeProductRating(...)` directly, whose resolved value is `ProductRatingRecord`, not
 * `void`) so this satisfies that signature exactly rather than relying on any return-type
 * variance. Every proof below that just wants "recompute normally" shares this one function. */
function recomputeApply(db: Kysely<unknown>): (row: OutboxRow) => Promise<void> {
  return async (row: OutboxRow): Promise<void> => {
    await recomputeProductRating(db, row.aggregateId, { outboxRowCreatedAt: row.createdAt });
  };
}

/** Bounded poll — every durability proof below waits for a real background process to make
 * progress rather than sleeping a guessed duration (ADR-0010). */
async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 100,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(`waitUntil: condition never became true within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

describe('reviews outbox relay durability (TASK-0005, SPEC-0004)', () => {
  let infra: ReviewsTestInfra;
  let redis: RedisInfra;

  beforeAll(async () => {
    infra = await startReviewsTestInfra();
    redis = await startRedisInfra();
  }, 240_000);

  afterAll(async () => {
    await redis.stop();
    await infra.stop();
  }, 60_000);

  // Proof 1 — replay. Mutation: in `src/internal/recompute-statement.ts`'s `applyRatingRecompute`,
  // drop `computed_at = excluded.computed_at` from the `ON CONFLICT DO UPDATE` SET list (the same
  // mutation `rating-rebuild.test.ts` names for its own idempotence proof) — the second
  // (redelivered) pass's `computed_at` would stay pinned at the first pass's value, and the
  // strictly-increased assertion below goes red. This proof is distinct from that one: it exercises
  // the OUTBOX path specifically — a row flipped back to `Pending` (an honest simulation of
  // at-least-once redelivery, not a rebuild call) and re-claimed by `relayOutboxBatch` itself.
  it('replaying a delivered outbox row leaves product_rating identical apart from computed_at', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 4,
      title: 'A solid first impression',
      body: 'Arrived on time and works exactly as the listing described.',
    });

    const apply = recomputeApply(infra.db);

    await relayOutboxBatch({ db: infra.db, outbox: REVIEWS_OUTBOX, apply });
    const afterFirst = await fetchProductRating(infra.db, product.productId);
    expect(afterFirst).toBeDefined();
    expect(afterFirst?.review_count).toBe(1);

    // Simulate at-least-once redelivery of the SAME event: flip the row back to Pending, exactly
    // the state a redelivered outbox event would present to the relay.
    await sql`
      UPDATE reviews.outbox
      SET outbox_row_status_id = ${OUTBOX_ROW_STATUS.Pending.id}, attempts = 0
      WHERE aggregate_id = ${product.productId}
    `.execute(infra.db);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await relayOutboxBatch({ db: infra.db, outbox: REVIEWS_OUTBOX, apply });
    const afterSecond = await fetchProductRating(infra.db, product.productId);

    expect(afterSecond?.review_count).toBe(afterFirst?.review_count);
    expect(afterSecond?.rating_average).toBe(afterFirst?.rating_average);
    expect(afterSecond?.computed_at.getTime()).toBeGreaterThan(
      afterFirst?.computed_at.getTime() ?? 0,
    );
  });

  // Proof 2 — kill mid-recompute, restart, converge. THE ONE ADR-0007's MACHINERY IS PAID FOR
  // (TASK-0005's own Notes). This is a GENUINE process kill: `relay-worker.probe.ts` runs as a real
  // `bun` OS process, driving the real `startOutboxRelay` against this suite's real containers; the
  // harness sends a real `SIGKILL` the instant the probe reports it finished WRITING
  // `reviews.product_rating` for the target product — i.e. after `recomputeProductRating`'s own SQL
  // ran, but strictly before `relayOutboxBatch`'s own claim transaction (which marks the outbox row
  // `Processed`) has any chance to commit, since nothing between that print and the kill touches
  // it. `apply`'s writes are NOT scoped to that transaction at all — `OutboxRelayOptions.apply`'s
  // signature carries no transaction parameter, a structural fact of the frozen spine, not a choice
  // this test makes — so the recompute's own write is free to have already landed (on its own,
  // separate, autocommitting connection) even though the outbox bookkeeping never does. Restarting
  // (a fresh `relayOutboxBatch` pass, in-process — a fresh call is what "restart" means for a
  // relay: there is no per-process state to lose) reclaims the still-pending row and reapplies
  // idempotently, and the projection converges to the value an INDEPENDENT calculation from
  // `reviews.review` gives — proving convergence regardless of what the killed attempt did or did
  // not durably commit.
  //
  // Mutation: in `packages/jobs/src/outbox.ts`'s `relayOutboxBatch`, change the claim `SELECT`'s
  // `WHERE outbox_row_status_id = Pending` to also exclude rows with `attempts > 0` — after the
  // kill (which never increments `attempts`, since that UPDATE is inside the same rolled-back
  // transaction) this would still pass; instead mutate the OUTER `db.transaction().execute` to
  // `db.transaction().execute(async (trx) => { ...; return report; })` with an added
  // `await trx.commit()` call before the per-row loop finishes (forcing an early, partial commit) —
  // the outbox row would be marked claimed/committed before the kill lands, the restart's claim
  // would then skip it (already non-`Pending`), and `product_rating` would never converge to the
  // authoritative value if the killed attempt's own write happened to fail partway. (This mutation
  // is described rather than applied, per this file's header honesty note.)
  it('killing the relay process mid-recompute and restarting it converges to the correct aggregate', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 5,
      title: 'Kept working great after weeks',
      body: 'No issues at all after several weeks of regular daily use.',
    });

    const probe = await runProbeUntilMarker(
      RELAY_PROBE_SCRIPT,
      {
        DATABASE_URL: infra.postgresUrl,
        REDIS_URL: redis.redisUrl,
        TARGET_PRODUCT_ID: product.productId,
        HOLD_MS: '4000',
      },
      'applied-target',
      30_000,
    );
    expect(probe.sawMarker).toBe(true);
    const marker = lastJsonLine(probe.stdout) as { event: string; reviewCount: number };
    expect(marker.event).toBe('applied-target');
    expect(marker.reviewCount).toBe(1);

    // The kill landed AFTER the write (the marker only prints once it resolved) and BEFORE the
    // relay's own claim transaction could commit (the process never got past its own `setTimeout`
    // hold) — so the OUTBOX ROW itself must still be exactly where the claim left it: pending,
    // never marked processed, `attempts` unmoved.
    const outboxAfterKill = await fetchOutboxStatus(infra.db, product.productId);
    expect(outboxAfterKill.status).toBe(OUTBOX_ROW_STATUS.Pending.id);
    expect(outboxAfterKill.attempts).toBe(0);

    // Restart: a fresh relay pass reclaims the still-pending row. Bounded retry, checking the
    // ROW'S OWN status directly rather than trusting one pass's report — the killed process's
    // Postgres backend needs a moment to be recognized as gone and its lock released, and until
    // then `FOR UPDATE SKIP LOCKED` makes a pass claim nothing (`claimed: 0`) for a reason
    // indistinguishable, from the report alone, from "there is nothing left to do".
    await waitUntil(async () => {
      await relayOutboxBatch({
        db: infra.db,
        outbox: REVIEWS_OUTBOX,
        apply: recomputeApply(infra.db),
      });
      const status = await fetchOutboxStatus(infra.db, product.productId);
      return status.status === OUTBOX_ROW_STATUS.Processed.id;
    }, 20_000);

    const outboxAfterRestart = await fetchOutboxStatus(infra.db, product.productId);
    expect(outboxAfterRestart.status).toBe(OUTBOX_ROW_STATUS.Processed.id);

    const converged = await fetchProductRating(infra.db, product.productId);
    const independent = await sql`
        SELECT count(*)::int AS review_count, round(avg(rating), 2) AS rating_average
        FROM reviews.review WHERE product_id = ${product.productId}
      `.execute(infra.db);
    const independentRow = independent.rows[0] as {
      review_count: number;
      rating_average: string | null;
    };
    expect(converged?.review_count).toBe(independentRow.review_count);
    expect(converged?.rating_average).toBe(independentRow.rating_average);
    // Test timeout (75_000, below) is comfortably above the sum of this test's own bounded waits
    // (30s for the marker, 20s for the restart) plus setup/query overhead — never a guessed sleep,
    // but the ceiling on top of two of them needs headroom of its own.
  }, 75_000);

  // Proof 3 — a flushed Redis loses no work. `flushAll()` runs a real `redis-cli FLUSHALL` inside
  // the real container (`RedisInfra`'s own doc explains why: this package has no sanctioned reason
  // to import `ioredis` directly). Mutation: in `packages/jobs/src/outbox.ts`'s `startOutboxRelay`,
  // delete the `await scheduleRepeatable({...})` call (keep only `createWorker`) — after the flush
  // there is no repeatable schedule left in Redis and none gets re-registered, no tick ever fires,
  // and the bounded wait below times out.
  it('flushing Redis loses no work: the pending row survives in Postgres and the re-registered schedule drains it', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 3,
      title: 'Does the job, nothing more',
      body: 'An average product that does exactly what it promises to do.',
    });

    await redis.flushAll();

    const beforeRestart = await fetchOutboxStatus(infra.db, product.productId);
    expect(beforeRestart.status).toBe(OUTBOX_ROW_STATUS.Pending.id);

    // Re-registers the repeatable schedule against the now-empty Redis — exactly what the
    // composition root does on every boot (`startOutboxRelay`'s `scheduleRepeatable` upsert).
    const relay = await startOutboxRelay({
      db: infra.db,
      outbox: REVIEWS_OUTBOX,
      connection: { redisUrl: redis.redisUrl },
      everyMs: 200,
      apply: recomputeApply(infra.db),
    });
    try {
      await waitUntil(
        async () => (await fetchProductRating(infra.db, product.productId)) !== undefined,
        15_000,
        200,
      );
    } finally {
      await relay.close();
    }

    const afterRestart = await fetchOutboxStatus(infra.db, product.productId);
    expect(afterRestart.status).toBe(OUTBOX_ROW_STATUS.Processed.id);
    const rating = await fetchProductRating(infra.db, product.productId);
    expect(rating?.review_count).toBe(1);
  }, 30_000);

  // Proof 4. A row whose application ALWAYS throws parks `dead` after exactly `maxAttempts` and is
  // never retried beyond it — proven with a fixed `maxAttempts` and one pass per attempt, matching
  // `packages/jobs/test-integration/outbox.test.ts`'s own poison-row pattern — AND (this file's
  // header, 2026-09-09 ruling) gets a `jobs.dead_letter` triage row for it, pipeline `reviews`.
  //
  // Mutation: in `packages/jobs/src/outbox.ts`'s `relayOutboxBatch`, change
  // `if (newAttempts >= maxAttempts)` to `if (newAttempts > maxAttempts)` — the row would then park
  // one attempt LATE (after `maxAttempts + 1` failures, not exactly `maxAttempts`), and the
  // `attempts === maxAttempts` / `status === Dead` assertions after the `maxAttempts`-th pass below
  // go red (the row is still `Pending`/`Failed` at that point instead).
  it('a row whose application always throws is parked dead after exactly maxAttempts and retries no further', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 2,
      title: 'This one never made it',
      body: 'A stand-in review whose recomputation is made to fail every time.',
    });

    const maxAttempts = 3;
    let poisonCalls = 0;
    const poisonApply = (row: OutboxRow): Promise<void> => {
      if (row.aggregateId === product.productId) {
        poisonCalls += 1;
        return Promise.reject(new Error(`poison apply failure (call ${poisonCalls})`));
      }
      return Promise.resolve();
    };

    for (let pass = 1; pass <= maxAttempts; pass += 1) {
      await relayOutboxBatch({
        db: infra.db,
        outbox: REVIEWS_OUTBOX,
        maxAttempts,
        apply: poisonApply,
      });
    }

    expect(poisonCalls).toBe(maxAttempts);
    const parked = await fetchOutboxStatus(infra.db, product.productId);
    expect(parked.status).toBe(OUTBOX_ROW_STATUS.Dead.id);
    expect(parked.attempts).toBe(maxAttempts);

    // Mutation: in `packages/jobs/src/outbox.ts`'s `relayOutboxBatch`, delete the
    // `await writeOutboxDeadLetter(trx, {...})` call from the parking branch — `deadLetterRows`
    // comes back empty and every assertion below goes red.
    const deadLetterRows = await fetchDeadLetterRows(infra.db, product.productId);
    expect(deadLetterRows).toHaveLength(1);
    expect(deadLetterRows[0]?.pipeline).toBe('reviews');
    expect(deadLetterRows[0]?.stage).toBe('reviews-outbox-relay');
    expect(deadLetterRows[0]?.attempts).toBe(maxAttempts);
    expect(deadLetterRows[0]?.reason.length).toBeGreaterThan(0);
    expect(deadLetterRows[0]?.reason).toContain('poison apply failure');

    // Retries no further: one more pass must not touch this row at all (it is no longer `Pending`).
    await relayOutboxBatch({
      db: infra.db,
      outbox: REVIEWS_OUTBOX,
      maxAttempts,
      apply: poisonApply,
    });
    expect(poisonCalls).toBe(maxAttempts);
    const stillParked = await fetchOutboxStatus(infra.db, product.productId);
    expect(stillParked.status).toBe(OUTBOX_ROW_STATUS.Dead.id);
    expect(stillParked.attempts).toBe(maxAttempts);

    // Replay guard: the row is no longer `Pending`, so this further pass never re-entered the
    // parking branch at all — the `ON CONFLICT DO NOTHING` target still holds exactly one row.
    // Mutation: in `packages/jobs/src/dead-letter.ts`'s `writeOutboxDeadLetter`, change the
    // `ON CONFLICT ON CONSTRAINT uq_dead_letter__pipeline_instance_id_stage_branch_key DO NOTHING`
    // target to a non-matching constraint (or drop the clause) — a second, direct call with the
    // same key would then throw a unique-violation instead of being silently absorbed, and a
    // production replay of a redelivered park would abort the whole relay pass.
    expect(await fetchDeadLetterRows(infra.db, product.productId)).toHaveLength(1);

    // No projection was ever written for a product whose only review never recomputed.
    expect(await fetchProductRating(infra.db, product.productId)).toBeUndefined();
  });

  // Proof 5 — the lag instrument records a value on every pass. Mutation: in `src/rating.ts`'s
  // `recomputeProductRating`, delete the
  // `if (options.outboxRowCreatedAt !== undefined) { ratingLagHistogram.record(...) }` block —
  // `lagRecords` stays empty and the `toBeGreaterThanOrEqual(1)` assertion below goes red.
  it('records a reviews.rating.lag value for every outbox row a pass applies', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 5,
      title: 'Measured, not assumed',
      body: 'The staleness number is measured, exactly as SPEC-0004 asks for.',
    });

    const before = meterRecords.length;
    await relayOutboxBatch({
      db: infra.db,
      outbox: REVIEWS_OUTBOX,
      apply: recomputeApply(infra.db),
    });

    const lagRecords = meterRecords
      .slice(before)
      .filter((record) => record.name === 'reviews.rating.lag');
    expect(lagRecords.length).toBeGreaterThanOrEqual(1);
    for (const record of lagRecords) {
      expect(record.value).toBeGreaterThanOrEqual(0);
      expect(record.attributes).toEqual({ outcome: 'success' });
    }

    const recomputeRecords = meterRecords
      .slice(before)
      .filter((record) => record.name === 'reviews.rating.recompute');
    expect(recomputeRecords.length).toBeGreaterThanOrEqual(1);
    expect(recomputeRecords.every((record) => record.attributes?.outcome === 'success')).toBe(true);
  });
});
