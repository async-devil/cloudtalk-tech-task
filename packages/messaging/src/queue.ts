import { injectTraceContext } from '@repo/observability';
import { Queue } from 'bullmq';
import { type BackoffOptions, DEFAULT_ATTEMPTS } from './backoff.js';
import type { MessagingConnection } from './connection.js';
import { bunRedisConnection } from './internal/bun-redis.js';
import { buildEnvelope, type Envelope } from './internal/envelope.js';
import { producerJobOptions } from './internal/producer-options.js';
import { jobIdFor } from './job-id.js';

/** Options accepted by {@link createQueue} (frozen — `TData` isn't referenced by this
 * interface's own fields, only by the sibling `Enqueuer<TData>` the same call constructs; kept
 * exactly as specified rather than renamed to satisfy the linter). */
// biome-ignore lint/correctness/noUnusedVariables: frozen signature, see comment above.
export interface QueueOptions<TData> {
  /** Queue name === stage name (ADR-0007). */
  readonly stage: string;
  readonly connection: MessagingConnection;
  /** @default 5 */
  readonly defaultAttempts?: number;
  /** Default `{ baseMs: 1000, capMs: 60_000 }`. Consumed by the sibling `createWorker`'s
   * `backoffStrategy` — the producer only needs to know attempts are backoff-driven; the shape
   * is carried through so both sides can be constructed from the same options in tests. */
  readonly backoff?: BackoffOptions;
}

/** Handle returned by {@link createQueue}. */
export interface Enqueuer<TData> {
  /** `jobId = ${stage}_${entityId}`. */
  enqueue(entityId: string, data: TData): Promise<void>;
  /** Queue-level GLOBAL pause (ADR-0007): state lives in Redis, so every worker on this
   * stage — not just this process — stops pulling new jobs; in-flight jobs finish. */
  pause(): Promise<void>;
  resume(): Promise<void>;
  /**
   * [additive amendment,] Removes the deterministic job for `entityId` on this
   * stage (`jobIdFor(stage, entityId)`) via BullMQ's `Queue.remove`. `true` when a job existed
   * and was removed, `false` when there was nothing to remove (already completed/never
   * enqueued/already removed) or the job could not be removed because it was locked (active) —
   * the reconciler's remove-then-re-add (ADR-0007) is impossible without this: a stale in-flight
   * job must be cleared before its same-jobId replacement can be re-added.
   *
   * `Queue.remove`'s own return code does NOT distinguish "removed" from "nothing to remove" —
   * BullMQ's `removeJob` Lua script (verified against this package's pinned 5.80.2) returns `1`
   * whenever the job is not currently locked, INCLUDING when it never existed at all; it returns
   * `0` only for a locked (active) job. Getting "true when a job existed and was removed" (the
   * frozen contract) therefore requires an existence check first — `getJob` — before calling
   * `remove`, not a bare read of `remove`'s own return value.
   */
  remove(entityId: string): Promise<boolean>;
  close(): Promise<void>;
}

/**
 * Wraps a BullMQ `Queue` for one stage. Every producer default is frozen: attempts
 * capped at `defaultAttempts` (default 5), a custom backoff (`{ type: 'custom' }` — resolved by
 * the sibling `createWorker`'s `fullJitterBackoff`-driven `backoffStrategy`),
 * `removeOnComplete: { count: 1000 }`, `removeOnFail: false`, and a deterministic `jobId`
 * (`jobIdFor`). The envelope carries the active trace context (`injectTraceContext`) so the
 * worker's span joins this call's trace (ADR-0009).
 */
export function createQueue<TData>(options: QueueOptions<TData>): Enqueuer<TData> {
  const queue = new Queue<Envelope<TData>>(options.stage, {
    connection: bunRedisConnection(options.connection),
  });
  const attempts = options.defaultAttempts ?? DEFAULT_ATTEMPTS;

  return {
    async enqueue(entityId: string, data: TData): Promise<void> {
      const envelope: Envelope<TData> = buildEnvelope(data, injectTraceContext());
      await queue.add(
        options.stage,
        envelope,
        producerJobOptions(options.stage, entityId, attempts),
      );
    },
    async pause(): Promise<void> {
      await queue.pause();
    },
    async resume(): Promise<void> {
      await queue.resume();
    },
    async remove(entityId: string): Promise<boolean> {
      const jobId = jobIdFor(options.stage, entityId);
      const job = await queue.getJob(jobId);
      if (job === undefined) {
        return false;
      }
      const removed = await queue.remove(jobId);
      return removed === 1;
    },
    async close(): Promise<void> {
      await queue.close();
    },
  };
}
