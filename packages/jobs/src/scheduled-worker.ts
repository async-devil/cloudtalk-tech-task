import type { WorkerHandle } from '@repo/messaging';

/**
 * What this module's three repeatable-wiring helpers return — `startOutboxRelay`,
 * `startReconciler` and `startRetention` (plus any future sibling of the same shape).
 *
 * Each of them does two things: it registers a repeatable schedule under a `schedulerId` it
 * computes itself, and it starts a worker to consume the resulting ticks. Both facts are needed by
 * anything that wants to answer "is this pipeline actually attached?", and until both were
 * discarded: the helpers built a real {@link WorkerHandle} internally and then returned
 * `{ close: () => worker.close() }`, narrowing away `isReady` and never surfacing the
 * `schedulerId` at all.
 *
 * That narrowing had a concrete cost, which is why this type exists. A caller
 * assembling the `/health/worker` probe could see only the workers it had constructed itself, so
 * the endpoint answered **200 while the outbox relay was dead** — precisely the failure that parks
 * outbox rows, and precisely the failure a "workers are actually attached" probe exists to catch.
 * The alternative available to the caller was to re-derive each `schedulerId` from this module's
 * private formula, which is the hand-typed-name risk that makes a probe report healthy forever
 * (`@repo/example-context`'s own scheduler check documents the same trap). Returning the facts is
 * the only version with no second copy of them.
 *
 * Extends {@link WorkerHandle} rather than wrapping it, so every existing caller — all of which
 * only ever call `close()` — keeps compiling unchanged.
 */
export interface ScheduledWorkerHandle extends WorkerHandle {
  /**
   * The repeatable-schedule id this helper registered with `scheduleRepeatable`, exactly as it
   * exists in Redis. Read it rather than reconstructing it: the formula is this module's own
   * implementation detail and is free to change.
   */
  readonly schedulerId: string;
  /**
   * The queue/stage the schedule above lives on. Needed alongside {@link schedulerId} because
   * BullMQ's scheduler registry is per-queue: asking "does this schedule exist?" requires both
   * halves, and a caller holding only the id would have to re-derive the stage — the same
   * re-typed-name trap, moved one field over.
   */
  readonly stage: string;
}
