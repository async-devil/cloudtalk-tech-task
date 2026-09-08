import { Queue } from 'bullmq';
import type { MessagingConnection } from './connection.js';
import { bunRedisConnection } from './internal/bun-redis.js';
import { boundedReadinessProbe } from './internal/readiness-probe.js';
import { repeatableJobTemplate, repeatOptionsFrom } from './internal/repeatable-options.js';

/** Options accepted by {@link scheduleRepeatable} (frozen). */
export interface RepeatableScheduleOptions<TData> {
  readonly stage: string;
  readonly connection: MessagingConnection;
  /** The upsert key: re-registering the same id REPLACES the schedule (idempotent boot —
   * composition roots call this every start without duplicating schedules). */
  readonly schedulerId: string;
  readonly every: { readonly milliseconds: number } | { readonly cronPattern: string };
  readonly data: TData;
}

/**
 * Idempotent repeatable-job registration (ADR-0007): wraps BullMQ's job schedulers
 * (`upsertJobScheduler`) — upsert by `schedulerId`, a boot-time call that opens and closes its
 * own queue handle (not a hot path). Scheduled ticks carry the standard envelope WITHOUT
 * `traceparent` (each tick starts a fresh trace); tick job ids come from BullMQ's scheduler, not
 * `jobIdFor` — the dedup story for repeatables is the scheduler id itself. Producer defaults
 * (attempts, backoff, retention) apply unchanged.
 */
export async function scheduleRepeatable<TData>(
  options: RepeatableScheduleOptions<TData>,
): Promise<void> {
  const queue = new Queue(options.stage, { connection: bunRedisConnection(options.connection) });
  try {
    const template = repeatableJobTemplate(options.stage, options.data);
    await queue.upsertJobScheduler(options.schedulerId, repeatOptionsFrom(options.every), {
      name: template.name,
      data: template.data,
      opts: template.opts,
    });
  } finally {
    await queue.close();
  }
}

/** Options accepted by {@link getRegisteredSchedulerIds} ('s amendment item 2,
 * additive). */
export interface RepeatableSchedulerLookupOptions {
  readonly stage: string;
  readonly connection: MessagingConnection;
}

/**
 * Which scheduler ids are currently registered in Redis for `stage` — the `/health/worker` probe
 *: opens and closes its own queue handle, exactly as
 * {@link scheduleRepeatable} does, and is bounded/non-throwing exactly like `WorkerHandle.isReady`
 * (`worker.ts`) — a probe that hangs or crashes its caller is a worse readiness signal than an
 * honest empty result. On any failure (the bounded deadline, or a Redis error) resolves to an
 * EMPTY set rather than throwing or propagating a partial list.
 *
 * **Reads BullMQ's `key` field, not its `id` field — verified against the pinned 5.80.2, not
 * assumed.** `Queue.getJobSchedulers()` returns `JobSchedulerJson`, which declares both `key` and
 * an optional `id`; for a scheduler registered the modern way (`upsertJobScheduler`, what
 * {@link scheduleRepeatable} calls), BullMQ's own `storeJobScheduler` Lua stores the caller's
 * `schedulerId` as the sorted-set MEMBER (`ZADD repeatKey nextMillis schedulerId`), and
 * `transformSchedulerData` echoes that member back as `key` — it never populates `id` for this
 * path (`id` is populated only by the legacy colon-encoded-key fallback `keyToData` handles,
 * which modern schedulers never hit). Matching on `id` here would report EVERY real scheduler
 * this module ever registers as permanently missing — the inverse failure of the hand-typed-name
 * trap this probe exists to avoid, and just as silent.
 */
export async function getRegisteredSchedulerIds(
  options: RepeatableSchedulerLookupOptions,
): Promise<ReadonlySet<string>> {
  const queue = new Queue(options.stage, { connection: bunRedisConnection(options.connection) });
  try {
    const schedulers = await boundedReadinessProbe(queue.getJobSchedulers());
    return new Set((schedulers ?? []).map((scheduler) => scheduler.key));
  } finally {
    // Never let a close failure turn a readiness probe into a throw (the same non-throwing
    // contract `isReady` above carries).
    await queue.close().catch(() => undefined);
  }
}
