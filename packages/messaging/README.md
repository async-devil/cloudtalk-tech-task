# messaging

## Purpose

Queue/worker wrappers over BullMQ () plus the messaging-complete
surface: a producer (`createQueue`) and
a consumer (`createWorker`) for one stage each, worker rate limiting + queue pause/resume,
idempotent repeatable-job scheduling (`scheduleRepeatable`), a Redis-Lua token-bucket rate
limiter for provider-side throttling, and `BestEffortEventBus` for cross-module acceleration
signals (ADR-0007). No module imports `bullmq` but this one (dep-cruiser
`adapters-and-sdk-only-in-runtime`, SO-1).

## Public contract

```ts
createQueue<TData>(options: QueueOptions<TData>): Enqueuer<TData>; // + pause()/resume()/remove()
createWorker<TData>(options: WorkerOptions<TData>): WorkerHandle; // options.limiter?, + isReady()
scheduleRepeatable<TData>(options: RepeatableScheduleOptions<TData>): Promise<void>;
getRegisteredSchedulerIds(options: RepeatableSchedulerLookupOptions): Promise<ReadonlySet<string>>;
createTokenBucketRateLimiter(options: TokenBucketOptions): RateLimiter;
createRequestsPerMinuteRateLimiter(options: { connection; bucketKey; requestsPerMinute }): RateLimiter;
computeTokenBucketRefill(state: { tokens; capacity; refillPerSecond; elapsedMs }): number;
createBestEffortEventBus<TEvent extends { type: string }>(options: { connection: MessagingConnection; schema: z.ZodType<TEvent> }): BestEffortEventBus<TEvent>;
BUS_CHANNEL: 'bus:events:v1';
fullJitterBackoff(attempt: number, options: BackoffOptions): number;
jobIdFor(stage: string, entityId: string): string;
JOB_OUTCOME: { Completed: 'completed'; RetryScheduled: 'retry-scheduled'; Terminal: 'terminal' };
```

## Dependencies

`bullmq@5.80.2` (the one Redis client dependency repo-wide — BullMQ's documented Bun adapter,
`createBunRedisClient` over `Bun.RedisClient`; no `ioredis`) + workspace `@repo/kernel`,
`@repo/observability`, `@repo/config`. `createBestEffortEventBus` takes its event schema as a
constructor option — this module owns no concrete bus-event vocabulary of its own, so it
has no `@repo/contracts` dependency. Dev-only:
`testcontainers@12.0.4`, `@opentelemetry/api@1.9.1` — never shipped in `src/`.

## Config slice

| env key | required | default (non-live) |
|---|---|---|
| `REDIS_URL` | always | — |

## Named invariants

<!-- Every invariant maps to a test id (ADR-0010.4); docs-check enforces. -->

- **INV-1** — `jobIdFor(stage, entityId)` = `` `${stage}_${entityId}` `` — deterministic, dedups
  via BullMQ's own `jobId`. Test: `test/job-id.test.ts`.
- **INV-2** — `fullJitterBackoff(attempt, options)` = `random(0, min(capMs, baseMs * 2**attempt))`
  — full jitter, capped. Test: `test/backoff.test.ts`.
- **INV-3** — producer defaults: `attempts` capped (default 5), custom backoff (`{ type: 'custom'
  }`, resolved by the sibling worker's `fullJitterBackoff`-driven `backoffStrategy`),
  `removeOnComplete: { count: 1000 }`, `removeOnFail: false`, deterministic `jobId`.
  Test: `test/producer-options.test.ts`.
- **INV-4** — the transport envelope is `{ traceparent?, tracestate?, data }`; `enqueue` fills it
  via `injectTraceContext()`. Test: `test/envelope.test.ts`.
- **INV-5** — the worker extracts the envelope, resumes the producer's trace
  (`runWithTraceContext`), and runs the handler inside a `jobs.{pipeline}.{stage}` span
  (`withJobStageSpan`, ADR-0009's sanctioned module-prefix exception), with entity id, stage, and
  attempt number as attributes. demo: `jobs.slice.uppercase-note`.
- **INV-6** — schema-parse failure of job data is terminal: routed through the same `failSpan` +
  `UnrecoverableError(describeError(error))` shape as any other terminal handler failure.
  Test: `test/worker.test.ts`.
- **INV-7** — the job boundary classifies via the kernel's `classifyRetry`, not a bare
  `isAppError && !retryable` check: Terminal ticks `messaging.job.execute`'s
  `{ queue, outcome: 'terminal' }`, logs exactly once via `failSpan`, and throws
  `UnrecoverableError(describeError(error))`; Retry ticks `{ queue, outcome: 'retry-scheduled' }`
  — no log, no `recordException` — and rethrows the ORIGINAL error for BullMQ's own
  attempts/backoff. Test: `test/worker.test.ts`.
- **INV-8** — raw handlers stay plain exported functions (ADR-0010.5): the composition root
  passes the same function to `createWorker` that queue-free tests import directly.
- **INV-9** — the configured Redis URL survives BullMQ's internal `duplicate()`/reconnects:
  Bun's `RedisClient` exposes no `url`, so the wrapper sets it as an expando the adapter reads —
  without it every blocking/pubsub connection silently targets Bun's DEFAULT Redis instead of
  the configured one. Test: `test/bun-redis.test.ts`.
- **INV-10** — the success path ticks the SAME `messaging.job.execute` instrument as both
  failure paths (`{ queue, outcome: 'completed' }`) — one shared counter, so the ADR-0009
  counter-dimension identity holds by construction, not convention. Test: `test/worker.test.ts`.
- **INV-11** — `WorkerOptions.limiter` maps `{ max, durationMs }` to BullMQ's worker-level
  `{ max, duration }`; `Enqueuer.pause`/`resume` wrap BullMQ's queue-level global pause verbatim.
  Test: `test/worker-limiter.test.ts`.
- **INV-12** — `scheduleRepeatable` is idempotent by `schedulerId` (BullMQ
  `upsertJobScheduler` — re-registering the same id REPLACES the schedule, never duplicates) and
  the scheduled envelope carries NO `traceparent`: a timer tick has no producer trace, so each
  tick starts a fresh one. Tick job ids come from BullMQ's own scheduler, not `jobIdFor` — a
  documented exception to INV-1. Test: `test/repeatable-options.test.ts`;
  `test-integration/messaging-complete.test.ts` (upsert-replaces-not-duplicates, live Redis).
- **INV-13** — the token bucket: `computeTokenBucketRefill` = `min(capacity, tokens +
  elapsedMs * refillPerSecond / 1000)`; a fresh/expired bucket starts FULL (capacity); the Redis
  hash self-cleans via `PEXPIRE` to twice the full-refill time. One `EVAL` per `tryAcquire` —
  atomic, so concurrent callers against one bucket never over-admit.
  Test: `test/rate-limiter.test.ts` (pure math); `test-integration/messaging-complete.test.ts`
  (burst/refill/concurrency against live Redis).
- **INV-14** — `BestEffortEventBus.publish` NEVER throws and never rejects (ADR-0007): a
  publish failure (e.g. Redis down) is logged once per interval (`suppressedCount` on the next
  emitted line) and ticks the publish counter `Terminal` — nothing crashes on non-delivery.
  Test: `test/bus.test.ts`.
- **INV-15** — the bus consume boundary: an unparseable envelope/event is swallowed via
  `failSpan` (Terminal, `queue: 'unknown'`); a delivered type with no registered handler ticks
  `Completed` and logs nothing; a throwing handler is swallowed (Terminal tick, one log) and does
  NOT stop the next handler or the next message — handlers run sequentially per message.
  Test: `test/bus.test.ts`; `test-integration/messaging-complete.test.ts` (real Redis delivery).
- **INV-16** — one pub/sub channel (`BUS_CHANNEL = 'bus:events:v1'`) carrying the standard
  envelope `{ traceparent?, tracestate?, event }`; publishers auto-inject the active W3C trace
  context via the same `injectTraceContext()` the job transport uses.
  Test: `test-integration/messaging-complete.test.ts` (wire envelope, live Redis).
- **INV-17** — `Enqueuer.remove(entityId)` wraps BullMQ
  `Queue.remove(jobIdFor(stage, entityId))`: `true` when a job existed and was removed, `false`
  when there was nothing to remove (already completed, or never enqueued). This is what makes the
  jobs-spine reconciler's remove-then-re-add (ADR-0007) possible — a stale in-flight job must be
  cleared before its same-jobId replacement can be re-added.
  Test: `test-integration/messaging-complete.test.ts` (live Redis, `probes/enqueuer-remove.probe.ts`).
- **INV-18** — `WorkerHandle.isReady()`
  checks BOTH `Worker.waitUntilReady()` (bounded to `internal/readiness-probe.ts`'s deadline) AND
  `Worker.isRunning()`: it resolves `false` — never throws — on a timed-out/failed connection
  check, and ALSO `false` after `close()` even though the connection came up cleanly before that
  (a connection-only check would report a stale `true` for a worker that has stopped processing).
  Test: `test-integration/messaging-complete.test.ts` (live Redis,
  `probes/worker-readiness.probe.ts`).
- **INV-19** — `getRegisteredSchedulerIds`
  matches BullMQ's `JobSchedulerJson.key` field, never its `id` field: for a scheduler registered
  via `upsertJobScheduler` (what `scheduleRepeatable` calls), BullMQ's own Lua stores the caller's
  `schedulerId` as the sorted-set member and echoes it back as `key`, leaving `id` unset — matching
  on `id` would report every real scheduler this module ever registers as permanently missing.
  Bounded and non-throwing (empty set on any failure), opens/closes its own queue handle exactly as
  `scheduleRepeatable` does. Test: `test-integration/messaging-complete.test.ts` (live Redis,
  `probes/scheduler-lookup.probe.ts`).

## Telemetry

Source record: [ADR-0009](../../docs/adr/ADR-0009-observability-through-a-facade.md).

<!-- Every emitted span/instrument maps to a line here; the telemetry-map gate enforces both
     directions (against src/ and against the source specs linked below). -->

**Spans:** none with a literal name. This module opens two spans whose names are *constructed at
runtime* and so cannot be enumerated here: `withJobStageSpan` names `jobs.{pipeline}.{stage}` from
the stage being run, and `withBusEventSpan` names its span from the delivered event type. They are
the reason every other module's span list can be literal — the dynamic pair lives here, once.
Out of scope for the telemetry-map gate by design.

**Instruments** (all module `messaging`, attributes `[Queue, Outcome]` — the shared-instrument
identity requires, so success and failure paths cannot drift apart):

| instrument | kind | attributes | values / semantics |
|---|---|---|---|
| `messaging.event.handle` | counter | Queue, Outcome | consume side, one tick per delivered event per handler; Queue = event type; `completed` / `terminal` (no `RetryScheduled` — the bus never retries) |
| `messaging.event.publish` | counter | Queue, Outcome | produce side; Queue = event type; `completed` / `terminal` |
| `messaging.job.execute` | counter | Queue, Outcome | one tick per job attempt; the success path and both failure paths share this instrument and dimension set by construction |

A delivered event whose envelope fails to parse records the bounded literal `unknown` as its
Queue — never a raw wire value (ADR-0009: bounded enums only).

## Extraction steps

Tier-facade, liftable: depends only on `@repo/kernel`, `@repo/observability`, `@repo/config`, and
`bullmq`. No other workspace module reaches into its `src/internal/`.
