/**
 * Probe: token bucket. Run as a real Bun process against a real Redis (harness/spawn-probe.ts).
 * Two checks: (1) burst a bucket to exhaustion, then real-time refill re-allows; (2) fire
 * concurrent `tryAcquire` calls against one bucket and confirm the Lua script's atomicity —
 * exactly `capacity` admissions, never more, regardless of concurrency.
 */

import process from 'node:process';
import { createTokenBucketRateLimiter } from '@repo/messaging';

const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined) {
  throw new Error('token-bucket probe: REDIS_URL is required');
}
const connection = { redisUrl };

const BURST_CAPACITY = 3;
// same class of flake as the sliding-window probe's original BURST_WINDOW_MS. At
// refillPerSecond=3, a full refill takes 1s — so the original single-limiter design needed the
// FOUR sequential `tryAcquire` calls below to complete inside ~1s, or the 4th call would see
// tokens that had already refilled and be wrongly admitted (`[true,true,true,true]` instead of
// `[true,true,true,false]`), same failure shape as the sliding-window burst under `moon ci`
// container-load contention. Refill rate here is not the property under test in burstToDenial()
// (only "burst exhausts capacity, then denies" is), so it is set two orders of magnitude slower —
// a full refill would take 100s, so contention would have to add ~100s of latency across four
// round trips to reproduce the failure. No round-trip latency was measured; the evidence is the
// same 30-forced-run soak recorded on the sliding-window probe (five of those runs with the
// container mutex removed), and an earlier version of this line claimed those latencies were
// "observed on this machine" when none were taken (review, H2 — the same false-provenance
// sentence appeared in both probes). Real-time refill re-admission (where elapsed time IS the
// property under test) is proved separately by refillReadmits() below, against its own
// fast-refilling bucket so that check stays fast without reintroducing the race.
const BURST_REFILL_PER_SECOND = 0.03;
// A second, independent bucket used only to prove real-time refill re-admits. Single call before
// the sleep (no multi-call sequential-latency risk), so it can stay fast: capacity 1 at 10/s means
// a full refill in 100ms.
const REFILL_CAPACITY = 1;
const REFILL_PER_SECOND = 10;
const CONCURRENCY_CAPACITY = 10;
const CONCURRENCY_ATTEMPTS = 30;

const BURST_COST = 1;

async function burstToDenial(): Promise<{
  burstAllowed: boolean[];
  exhaustedRemaining: number;
  exhaustedRetryAfterMs: number;
  // Echoed back (rather than the test file duplicating these as separate magic numbers) so the
  // Vitest side can recompute computeTokenBucketRetryAfterMs from the EXACT inputs the live Lua
  // script used and assert exact agreement ("the pure mirror and the Lua agree").
  refillPerSecond: number;
  cost: number;
}> {
  const limiter = createTokenBucketRateLimiter({
    connection,
    bucketKey: `probe:burst:${crypto.randomUUID()}`,
    capacity: BURST_CAPACITY,
    refillPerSecond: BURST_REFILL_PER_SECOND,
  });

  const burstAllowed: boolean[] = [];
  let exhaustedRemaining = -1;
  let exhaustedRetryAfterMs = -1;
  for (let i = 0; i < BURST_CAPACITY + 1; i += 1) {
    const decision = await limiter.tryAcquire(BURST_COST);
    burstAllowed.push(decision.allowed);
    if (!decision.allowed) {
      // `remainingTokens` on a denial is the refilled-but-not-decremented amount Lua computed —
      // the exact `refilled` input its own retryAfterMs formula used, so feeding it back into the
      // pure mirror reproduces the Lua's output deterministically (no clock-skew risk: we're not
      // recomputing refill from elapsed time client-side, just replaying Lua's own intermediate).
      exhaustedRemaining = decision.remainingTokens;
      exhaustedRetryAfterMs = decision.retryAfterMs;
    }
  }

  await limiter.close();
  return {
    burstAllowed,
    exhaustedRemaining,
    exhaustedRetryAfterMs,
    refillPerSecond: BURST_REFILL_PER_SECOND,
    cost: BURST_COST,
  };
}

async function refillReadmits(): Promise<{ refillAllowed: boolean }> {
  const limiter = createTokenBucketRateLimiter({
    connection,
    bucketKey: `probe:refill:${crypto.randomUUID()}`,
    capacity: REFILL_CAPACITY,
    refillPerSecond: REFILL_PER_SECOND,
  });

  await limiter.tryAcquire(BURST_COST); // drains the bucket's one token.

  // Real-time refill IS the property under test here, so it stays real-time rather than mocked —
  // kept fast (100ms full refill) rather than shortened away, with a 400ms margin.
  await new Promise((resolve) => setTimeout(resolve, 500));
  const refillDecision = await limiter.tryAcquire();

  await limiter.close();
  return { refillAllowed: refillDecision.allowed };
}

async function concurrentNeverOverAdmits(): Promise<{ allowedCount: number; deniedCount: number }> {
  const limiter = createTokenBucketRateLimiter({
    connection,
    bucketKey: `probe:concurrent:${crypto.randomUUID()}`,
    capacity: CONCURRENCY_CAPACITY,
    // Negligible refill during the burst window — isolates the atomicity check from real-time
    // refill (still > 0 per the frozen contract).
    refillPerSecond: 0.001,
  });

  const decisions = await Promise.all(
    Array.from({ length: CONCURRENCY_ATTEMPTS }, () => limiter.tryAcquire()),
  );
  await limiter.close();

  const allowedCount = decisions.filter((decision) => decision.allowed).length;
  const deniedCount = decisions.length - allowedCount;
  return { allowedCount, deniedCount };
}

async function main(): Promise<void> {
  const burst = await burstToDenial();
  const refill = await refillReadmits();
  const concurrency = await concurrentNeverOverAdmits();
  process.stdout.write(`${JSON.stringify({ burst, refill, concurrency })}\n`);
}

await main();
