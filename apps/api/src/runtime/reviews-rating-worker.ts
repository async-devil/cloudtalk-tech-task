import { purgeDeadLetters, type ScheduledWorkerHandle, startOutboxRelay } from '@repo/jobs';
import {
  createWorker,
  getRegisteredSchedulerIds,
  type MessagingConnection,
  scheduleRepeatable,
} from '@repo/messaging';
import { REVIEWS_OUTBOX, recomputeProductRating } from '@repo/reviews';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { WorkerHealth } from './worker-liveness.js';

/**
 * The reviews rating-aggregation background worker (TASK-0005, SPEC-0004, ADR-0007, ADR-0014):
 * the outbox relay that turns a `reviews.outbox` row into a `recomputeProductRating` call, plus
 * this pipeline's own dead-letter retention. Concrete adapter wiring — a real `Kysely` handle and
 * a real Redis connection turned into a running worker — lives HERE, not in `@repo/reviews`
 * (ADR-0005: concrete adapters exist only in `apps/*​/src/runtime/**`); `@repo/reviews` exports only
 * the pure `recomputeProductRating`/`REVIEWS_OUTBOX`, and `runtime/main.ts` calls this file to turn
 * them into the running thing.
 *
 * `apply` IS `recomputeProductRating` (SPEC-0004's own words), passed straight to
 * `startOutboxRelay` below with no wrapper around it. A parked row's `jobs.dead_letter` triage row
 * (SPEC-0004's Retention/telemetry table: "at `maxAttempts` the row is parked `dead` and a
 * `jobs.dead_letter` row is written for triage") used to be a gap THIS FILE closed — a raw `INSERT`
 * plus a copy of `relayOutboxBatch`'s own attempts-ceiling predicate, so the triage write could
 * fire on what it guessed was the terminal attempt. That duplicated four of the spine's own
 * invariants across a module boundary (the reason-length cap, the relay's stage-naming formula,
 * the dead-letter `ON CONFLICT` target, and the ceiling predicate itself) and could not be atomic
 * with the park it was meant to explain. It is gone: `@repo/jobs`'s `relayOutboxBatch` now writes
 * that row itself, inside its own claim transaction, via `writeOutboxDeadLetter`
 * (`packages/jobs/src/dead-letter.ts` — its header explains why that function exists alongside
 * `writeDeadLetter`). The table, its conflict semantics and the ceiling all already lived in the
 * spine; now the write does too, and this composition root has nothing left to duplicate.
 *
 * NO RECONCILER, DELIBERATELY (SPEC-0004 "why the relay applies directly", TASK-0005's amended
 * criterion): the relay's own pending-row scan is this pipeline's whole recovery story — a row
 * stays `pending` in Postgres until a pass applies it, so nothing here needs to re-enqueue
 * anything a crash or a flushed Redis might have dropped.
 *
 * GAP RECORDED, NOT WORKED AROUND — `reviews.outbox`'s processed/dead-row retention. SPEC-0004's
 * Retention section describes `processedOutboxRetainMs`/`deadOutboxRetainMs` as "applied by the
 * spine's retention pass" (`@repo/jobs`'s `purgePipelineData`/`startRetention`). That pass takes a
 * full `PipelineTableContract` and UNCONDITIONALLY purges `{contract.table}_stage_result` — a
 * sibling table this outbox-only pipeline does not have and, per this same specification, is not
 * supposed to need (there is no stage pipeline here to write one). Pointing a contract at any of
 * `reviews.product`/`review`/`outbox` would make that pass run `DELETE FROM
 * reviews.<table>_stage_result` against a table that does not exist, and creating one solely to
 * satisfy the API would misrepresent this pipeline as having a stage it does not. So this file
 * does NOT call `purgePipelineData`/`startRetention` — only `jobs.dead_letter`'s own reviews-
 * pipeline rows are purged below, through the contract-free `purgeDeadLetters`. Closing the
 * `reviews.outbox` gap needs a `@repo/jobs` change (an outbox-only retention entry point that does
 * not require a stage-result table) that is outside this change's authorized surface — flagged
 * here, in code, rather than silently left for `reviews.outbox` to grow without bound.
 */

/** `scheduleRepeatable`/`createWorker` both require a data schema even for a payload-less tick;
 * this package carries no shared `zod` schema of its own to reuse (matches `@repo/jobs`'s own
 * `internal/tick.ts` — not importable, `internal/` never crosses a module boundary). */
const emptyTickSchema = z.object({}).strict();

/** Distinct from `@repo/jobs`'s own `retention:{pipeline}` naming (`startRetention`) on purpose:
 * this is NOT that pass (see this file's header) and must never collide with one that closes the
 * gap above later. */
const REVIEWS_DEAD_LETTER_RETENTION_STAGE = 'reviews-dead-letter-retention';
const REVIEWS_DEAD_LETTER_RETENTION_SCHEDULER_ID = 'retention:reviews-dead-letter';

export interface ReviewsRatingWorkerOptions {
  readonly db: Kysely<unknown>;
  readonly connection: MessagingConnection;
  /** The relay's poll interval — the staleness budget (SPEC-0004 open question 3; SPEC-0001
   * promises "within seconds"). A composition-root knob, owned by the caller (`runtime/main.ts`),
   * not defaulted here. */
  readonly relayEveryMs: number;
  /** Parks a row `dead` once its attempts reach this (`relayOutboxBatch`'s own ceiling, SPEC-0004)
   * — a composition-root knob passed explicitly rather than left to `@repo/jobs`'s internal
   * default, same precedent as `relayEveryMs` above. `relayOutboxBatch` now also uses this SAME
   * number to decide when to write the row's `jobs.dead_letter` triage entry, so there is only
   * ever one ceiling to tune, inside the spine. */
  readonly relayMaxAttempts: number;
  /** `jobs.dead_letter`'s reviews-pipeline purge horizon (SPEC-0004 Retention) — must exceed
   * `deadLetterStaleAfterMs`; `purgeDeadLetters` itself enforces that floor. */
  readonly deadLetterRetainMs: number;
  /** The ADR-0006 floor for the horizon above. This pipeline has no reconciler and no in-flight
   * external call (SPEC-0004 open question 1) — nothing a purge could "re-bill" mid-flight — so
   * this is a nominal value comfortably above one relay pass's worst-case hold time, not a real
   * in-flight window. */
  readonly deadLetterStaleAfterMs: number;
  readonly deadLetterRetentionEveryMs: number;
}

export interface ReviewsRatingWorker {
  readonly relay: ScheduledWorkerHandle;
  readonly deadLetterRetention: ScheduledWorkerHandle;
  /** The `/health/worker` probe's seam for this pipeline's two workers (`worker-liveness.ts`'s
   * `WorkerHealth`) — checks both `isReady()` AND that each worker's own `schedulerId` is actually
   * registered in Redis, never re-deriving either from a second copy of the formula. */
  checkHealth(): Promise<WorkerHealth>;
  close(): Promise<void>;
}

/**
 * Starts the relay (`apply` is `recomputeProductRating` itself, per SPEC-0004 — the parked-row
 * `jobs.dead_letter` triage write is now `relayOutboxBatch`'s own concern, not this composition
 * root's) and the reviews dead-letter retention pass, and returns both handles plus a combined
 * health probe and a combined `close`.
 */
export async function startReviewsRatingWorker(
  options: ReviewsRatingWorkerOptions,
): Promise<ReviewsRatingWorker> {
  const relay = await startOutboxRelay({
    db: options.db,
    outbox: REVIEWS_OUTBOX,
    connection: options.connection,
    everyMs: options.relayEveryMs,
    maxAttempts: options.relayMaxAttempts,
    apply: async (row) => {
      await recomputeProductRating(options.db, row.aggregateId, {
        outboxRowCreatedAt: row.createdAt,
      });
    },
  });

  await scheduleRepeatable({
    stage: REVIEWS_DEAD_LETTER_RETENTION_STAGE,
    connection: options.connection,
    schedulerId: REVIEWS_DEAD_LETTER_RETENTION_SCHEDULER_ID,
    every: { milliseconds: options.deadLetterRetentionEveryMs },
    data: {},
  });
  const deadLetterWorker = createWorker({
    stage: REVIEWS_DEAD_LETTER_RETENTION_STAGE,
    pipeline: 'reviews',
    connection: options.connection,
    schema: emptyTickSchema,
    handler: async () => {
      await purgeDeadLetters({
        db: options.db,
        pipeline: 'reviews',
        retainMs: options.deadLetterRetainMs,
        staleAfterMs: options.deadLetterStaleAfterMs,
      });
    },
  });
  const deadLetterRetention: ScheduledWorkerHandle = {
    ...deadLetterWorker,
    schedulerId: REVIEWS_DEAD_LETTER_RETENTION_SCHEDULER_ID,
    stage: REVIEWS_DEAD_LETTER_RETENTION_STAGE,
  };

  const workers: readonly ScheduledWorkerHandle[] = [relay, deadLetterRetention];

  async function checkHealth(): Promise<WorkerHealth> {
    const [readyFlags, registeredByWorker] = await Promise.all([
      Promise.all(workers.map((worker) => worker.isReady())),
      Promise.all(
        workers.map((worker) =>
          getRegisteredSchedulerIds({ stage: worker.stage, connection: options.connection }),
        ),
      ),
    ]);
    const missingSchedulerIds = workers
      .filter((worker, index) => !(registeredByWorker[index]?.has(worker.schedulerId) ?? false))
      .map((worker) => worker.schedulerId);
    return {
      workersReady: readyFlags.every((ready) => ready),
      missingSchedulerIds,
      checkedSchedulerIds: workers.map((worker) => worker.schedulerId),
      checkedWorkerCount: workers.length,
    };
  }

  return {
    relay,
    deadLetterRetention,
    checkHealth,
    async close(): Promise<void> {
      await relay.close();
      await deadLetterRetention.close();
    },
  };
}
