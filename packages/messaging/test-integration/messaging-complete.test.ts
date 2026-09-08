/**
 * — the integration proof: three probes, each spawned as a real `bun` process
 * against one shared `redis:8-alpine` Testcontainer (ADR-0010 §6 escape hatch — see
 * harness/spawn-probe.ts's header for the Bun-globals-under-Vitest reasoning). One container for
 * the whole file (not one per probe): none of these three probes share mutable state — each uses
 * a fresh/random bucket key, scheduler id, or bus channel round — so a single Redis keeps the
 * suite fast without weakening isolation.
 */

import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeTokenBucketRetryAfterMs } from '../src/internal/token-bucket-retry.js';
import { type RedisInfra, startRedisInfra } from './harness/redis-container.js';
import { lastJsonLine, runProbe } from './harness/spawn-probe.js';

const BUS_ROUND_TRIP_PROBE = fileURLToPath(
  new URL('./probes/bus-round-trip.probe.ts', import.meta.url),
);
const TOKEN_BUCKET_PROBE = fileURLToPath(
  new URL('./probes/token-bucket.probe.ts', import.meta.url),
);
const SCHEDULE_REPEATABLE_PROBE = fileURLToPath(
  new URL('./probes/schedule-repeatable.probe.ts', import.meta.url),
);
const ENQUEUER_REMOVE_PROBE = fileURLToPath(
  new URL('./probes/enqueuer-remove.probe.ts', import.meta.url),
);
const SLIDING_WINDOW_PROBE = fileURLToPath(
  new URL('./probes/sliding-window.probe.ts', import.meta.url),
);
const WORKER_READINESS_PROBE = fileURLToPath(
  new URL('./probes/worker-readiness.probe.ts', import.meta.url),
);
const SCHEDULER_LOOKUP_PROBE = fileURLToPath(
  new URL('./probes/scheduler-lookup.probe.ts', import.meta.url),
);

describe('integration proof (Testcontainers redis:8-alpine)', () => {
  let infra: RedisInfra;

  beforeAll(async () => {
    infra = await startRedisInfra();
  }, 120_000);

  afterAll(async () => {
    await infra.stop();
  }, 120_000);

  it('bus round-trip: wire traceparent, at-most-once swallow, next event still delivered', async () => {
    const result = await runProbe(BUS_ROUND_TRIP_PROBE, infra.redisUrl);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = lastJsonLine(result.stdout);

    expect(payload.firstHandlerRan).toBe(true);
    // The wiretap (a raw subscriber bypassing the bus's own API) proves the LITERAL wire envelope
    // carries the publisher's traceparent, byte-for-byte, across a real Redis hop.
    expect(payload.wiretapTraceparent).toBe(payload.expectedTraceparent);

    // Swallow semantics: the first message's only handler threw, yet the probe exited 0 (no
    // crash) and the SECOND, independently-published event still reached its handler (proving
    // one failing handler/message never stops the next).
    expect(payload.secondReceived).toStrictEqual(['22222222-2222-4222-8222-222222222222']);
  }, 30_000);

  it('token bucket: burst to exhaustion then real-time refill; concurrent callers never over-admit', async () => {
    const result = await runProbe(TOKEN_BUCKET_PROBE, infra.redisUrl);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = lastJsonLine(result.stdout);

    const burst = payload.burst as {
      burstAllowed: boolean[];
      exhaustedRemaining: number;
      exhaustedRetryAfterMs: number;
      refillPerSecond: number;
      cost: number;
    };
    // capacity 3: first 3 admitted, the 4th (burst) denied. burstToDenial() runs at a deliberately
    // slow refill rate specifically so this
    // stays true under `moon ci` container-load contention — the refill RATE is not what's being
    // asserted here, only that a burst inside one "no meaningful refill happened yet" window is
    // capped at `capacity`. Real-time refill re-admission is proved separately below (`refill`,
    // refillReadmits() in the probe) against its own fast-refilling bucket.
    expect(burst.burstAllowed).toStrictEqual([true, true, true, false]);
    // NOT `toBeCloseTo(0, 1)`: the token bucket refills continuously by real elapsed time (the
    // Lua script's own design), so the gap between "tokens hit 0" and "the exhausting
    // call's response" genuinely refills a small, real amount — negligible on a fast machine, but
    // a CPU-starved CI run (many parallel Testcontainers suites) can stretch that gap enough for a
    // fixed near-zero assertion to flip flaky. A client-side elapsed-time bracket was tried first
    // and discarded: correctly bounding a server-clock interval from client-observed timestamps
    // turned out to have no safe construction over an unbounded number of round trips (send/receive
    // timestamps on different calls carry different, uncorrelated network latencies) and it still
    // flaked. The Lua script's OWN branch condition is the real, timing-independent invariant: it
    // sets `allowed = 0` if and only if `refilled < cost` (`token-bucket-lua.ts`), so a denial
    // guarantees `0 <= exhaustedRemaining < cost` by construction — no clock reasoning needed at
    // all, client or server.
    expect(burst.exhaustedRemaining).toBeGreaterThanOrEqual(0);
    expect(burst.exhaustedRemaining).toBeLessThan(burst.cost);
    expect(burst.exhaustedRetryAfterMs).toBeGreaterThan(0);

    const refill = payload.refill as { refillAllowed: boolean };
    expect(refill.refillAllowed).toBe(true);
    //: "the pure mirror and the Lua agree" — replay the EXACT `refilled`/`cost`/
    // `refillPerSecond` inputs the live Lua script used (echoed back by the probe) through the
    // pure computeTokenBucketRetryAfterMs and assert byte-for-byte agreement with what the real
    // Redis round-trip produced, not just "> 0".
    expect(burst.exhaustedRetryAfterMs).toBe(
      computeTokenBucketRetryAfterMs({
        cost: burst.cost,
        refilled: burst.exhaustedRemaining,
        refillPerSecond: burst.refillPerSecond,
      }),
    );

    const concurrency = payload.concurrency as { allowedCount: number; deniedCount: number };
    // capacity 10, 30 concurrent attempts, negligible refill — atomicity means EXACTLY 10 admitted.
    expect(concurrency.allowedCount).toBe(10);
    expect(concurrency.deniedCount).toBe(20);
  }, 30_000);

  it('scheduleRepeatable: re-registering the same schedulerId upserts (exactly one, second config wins)', async () => {
    const result = await runProbe(SCHEDULE_REPEATABLE_PROBE, infra.redisUrl);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = lastJsonLine(result.stdout);

    expect(payload.schedulerCount).toBe(1);
    expect(payload.every).toBe(5_000);
  }, 30_000);

  it('Enqueuer.remove: true for an existing job, false on replay and for an unknown entity', async () => {
    const result = await runProbe(ENQUEUER_REMOVE_PROBE, infra.redisUrl);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = lastJsonLine(result.stdout);

    expect(payload.removedExisting).toBe(true);
    expect(payload.removedAgain).toBe(false);
    expect(payload.removedNeverEnqueued).toBe(false);
  }, 30_000);

  it('sliding window: burst to exhaustion with a positive retryAfterMs, window expiry re-admits, concurrent probes never over-admit, fail-open on an unreachable Redis (wi-11 spec §3/§10.7)', async () => {
    // 90s: the fail-open case (bare Bun.RedisClient defaults, report) waits out Bun's own
    // reconnect/backoff budget (~30s empirically) against a genuinely unreachable host before
    // this probe's own client gives up and the limiter converts that into a fail-open decision.
    const result = await runProbe(SLIDING_WINDOW_PROBE, infra.redisUrl, 90_000);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = lastJsonLine(result.stdout);

    const burst = payload.burst as {
      burstAllowed: boolean[];
      exhaustedRemaining: number;
      exhaustedRetryAfterMs: number;
    };
    // limit 3: first 3 admitted, the 4th denied. burstExhaustion() runs against a 45s window
    // specifically so this stays true under `moon ci` container-load contention — the
    // window's SIZE is not what's being asserted here, only that a burst inside one window is
    // capped at `limit`.
    expect(burst.burstAllowed).toStrictEqual([true, true, true, false]);
    expect(burst.exhaustedRemaining).toBe(0);
    expect(burst.exhaustedRetryAfterMs).toBeGreaterThan(0);

    const windowExpiry = payload.windowExpiry as { afterWindowAllowed: boolean };
    // Separate, short-lived window: ageing-out re-admission IS a wall-clock property, so
    // it is proved with a real sleep rather than mocked — but against its OWN small window
    // (windowExpiryReadmits(), 400ms) so it carries no dependency on the burst window's size.
    expect(windowExpiry.afterWindowAllowed).toBe(true);

    const concurrency = payload.concurrency as { allowedCount: number; deniedCount: number };
    // limit 10, 30 concurrent attempts, one window — atomicity means EXACTLY 10 admitted.
    expect(concurrency.allowedCount).toBe(10);
    expect(concurrency.deniedCount).toBe(20);

    const failOpen = payload.failOpen as {
      allowed: boolean;
      degraded: boolean;
      elapsedMs: number;
    };
    expect(failOpen.allowed).toBe(true);
    expect(failOpen.degraded).toBe(true);
    // The fail-open must be BOUNDED, not merely eventual: this
    // limiter is awaited before an inbound request is served, so an unbounded wait on an
    // unreachable Redis converts a cache outage into an origin outage — the exact failure the
    // fail-open branch exists to prevent. Ceiling is generous against the 250ms
    // REDIS_CALL_DEADLINE_MS so container-load jitter cannot flake it, while still failing loudly
    // if the deadline is ever removed (unbounded was ~30s).
    expect(failOpen.elapsedMs).toBeLessThan(5_000);
  }, 90_000);

  it('WorkerHandle.isReady: true while the worker is up, false once close() has run', async () => {
    const result = await runProbe(WORKER_READINESS_PROBE, infra.redisUrl);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = lastJsonLine(result.stdout);

    expect(payload.readyBeforeClose).toBe(true);
    // The connection came up cleanly and never itself failed — only `isRunning()` flips here,
    // which is why `isReady()` cannot check `waitUntilReady()` alone (amendment
    // item 2, README INV-18).
    expect(payload.readyAfterClose).toBe(false);
  }, 30_000);

  it("getRegisteredSchedulerIds: finds a real scheduler by its OWN schedulerId, not by BullMQ's (unset) `id` field", async () => {
    const result = await runProbe(SCHEDULER_LOOKUP_PROBE, infra.redisUrl);
    expect(result.exitCode, result.stderr).toBe(0);
    const payload = lastJsonLine(result.stdout);

    // The load-bearing assertion (README INV-19): a scheduler registered through the real
    // `scheduleRepeatable` -> `upsertJobScheduler` path is found by the SAME id that registered
    // it. Matching BullMQ's `id` field instead of `key` would make this `false` — every real
    // scheduler this module ever registers would report as permanently missing.
    expect(payload.includesRegistered).toBe(true);
    expect(payload.includesBogus).toBe(false);
    expect(payload.emptyStageSize).toBe(0);
  }, 30_000);
});
