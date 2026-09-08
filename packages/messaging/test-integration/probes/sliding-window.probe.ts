/**
 * wi-11 security-baseline probe: sliding window. Run as a real Bun process against
 * a real Redis (harness/spawn-probe.ts) — same "Bun-globals under Vitest" constraint as the
 * token-bucket probe. Three checks: (1) burst a window to exhaustion, deny with a positive
 * `retryAfterMs`, then real-time-past-window re-admits; (2) fire concurrent `tryAcquire` calls
 * against one subject and confirm the Lua script's atomicity — exactly `limit` admissions, never
 * more; (3) fail-open: point a limiter at an unreachable Redis and confirm `allowed: true`,
 * `degraded: true`.
 */

import process from 'node:process';
import { createSlidingWindowRateLimiter } from '@repo/messaging';

const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined) {
  throw new Error('sliding-window probe: REDIS_URL is required');
}
const connection = { redisUrl };

const BURST_LIMIT = 3;
// this window's SIZE is not the property under test in burstExhaustion() below — the
// property is "limit admissions, then denial, in one window", not "1.5s specifically". The
// original 1_500ms gave only a ~1.5s margin over four SEQUENTIAL Redis round trips, and under a
// contended `moon ci` (up to seven test-integration Testcontainers stacks booting at once before
// the mutex fix in.moon/tasks/all.yml) that margin was sometimes consumed entirely: the first
// probe's window-entry aged out before the fourth probe ran, so the failure recorded against this
// suite in was `[true, true, true, true]` — the limiter correctly re-admitting into an
// ALREADY-EXPIRED window while the assertion still expected exhaustion. Widened three orders of
// magnitude (45s) so contention would need to add ~45s of latency to four Redis round trips to
// reproduce the same failure.
//
// EVIDENCE, and stated as exactly what it is: 30 consecutive FORCED full container runs, 38/38
// green each time, the first five with `.moon/tasks/all.yml`'s `container-test-integration` mutex
// deliberately REMOVED so the wall-clock fix is proven under real parallel contention rather than
// behind the serialization that hides it. That is 30 green runs — it is NOT a cured observed
// failure, because the original flake was never reproduced red on this machine. No per-round-trip
// latency was measured. (An earlier version of this comment claimed a hand-run measurement of
// ">1.6s between the first and fourth call on this machine"; that measurement never happened — the
// container runtime was down for that session. review, H2. An unverified number in a
// security proof is read as evidence by the next person to touch the file.)
// Window-EXPIRY re-admission (where
// the ageing genuinely IS the property under test) is deliberately NOT tested here — see
// windowExpiryReadmits() below, which uses its own small, dedicated window so that real test stays
// fast and its own margin stays wide.
const BURST_WINDOW_MS = 45_000;
// A second, SHORT-lived window used only to prove ageing-out re-admits (windowExpiryReadmits()).
// Deliberately decoupled from BURST_WINDOW_MS: this one call-then-sleep shape has no multi-call
// sequential-latency risk (a single `tryAcquire` before the sleep), so it can stay short without
// reintroducing the class of flake above. 400ms is still ~2 orders of magnitude above a healthy
// round trip; the sleep pads by 600ms (1_000ms total) rather than +500ms so the same margin
// applies here too.
const WINDOW_EXPIRY_MS = 400;
const CONCURRENCY_LIMIT = 10;
const CONCURRENCY_ATTEMPTS = 30;

async function burstExhaustion(): Promise<{
  burstAllowed: boolean[];
  exhaustedRemaining: number;
  exhaustedRetryAfterMs: number;
}> {
  const limiter = createSlidingWindowRateLimiter({
    connection,
    bucketKeyPrefix: `probe:sliding-window:burst:${crypto.randomUUID()}`,
    limit: BURST_LIMIT,
    windowMs: BURST_WINDOW_MS,
  });

  const subject = 'subject-a';
  const burstAllowed: boolean[] = [];
  let exhaustedRemaining = -1;
  let exhaustedRetryAfterMs = -1;
  for (let i = 0; i < BURST_LIMIT + 1; i += 1) {
    const decision = await limiter.tryAcquire(subject);
    burstAllowed.push(decision.allowed);
    if (!decision.allowed) {
      exhaustedRemaining = decision.remaining;
      exhaustedRetryAfterMs = decision.retryAfterMs;
    }
  }

  await limiter.close();
  return { burstAllowed, exhaustedRemaining, exhaustedRetryAfterMs };
}

async function windowExpiryReadmits(): Promise<{ afterWindowAllowed: boolean }> {
  const limiter = createSlidingWindowRateLimiter({
    connection,
    bucketKeyPrefix: `probe:sliding-window:expiry:${crypto.randomUUID()}`,
    limit: 1,
    windowMs: WINDOW_EXPIRY_MS,
  });

  const subject = 'subject-expiry';
  await limiter.tryAcquire(subject); // fills the window's only slot.

  // Past the window: every pruned member ages out, so a fresh acquire is admitted again. This IS
  // the wall-clock property under test, so it stays real-time rather than mocked — kept fast (see
  // WINDOW_EXPIRY_MS above) rather than shortened away.
  await new Promise((resolve) => setTimeout(resolve, WINDOW_EXPIRY_MS + 600));
  const afterWindow = await limiter.tryAcquire(subject);

  await limiter.close();
  return { afterWindowAllowed: afterWindow.allowed };
}

async function concurrentNeverOverAdmits(): Promise<{
  allowedCount: number;
  deniedCount: number;
}> {
  const limiter = createSlidingWindowRateLimiter({
    connection,
    bucketKeyPrefix: `probe:sliding-window:concurrent:${crypto.randomUUID()}`,
    limit: CONCURRENCY_LIMIT,
    windowMs: 60_000,
  });

  const decisions = await Promise.all(
    Array.from({ length: CONCURRENCY_ATTEMPTS }, () => limiter.tryAcquire('subject-b')),
  );
  await limiter.close();

  const allowedCount = decisions.filter((decision) => decision.allowed).length;
  return { allowedCount, deniedCount: decisions.length - allowedCount };
}

async function failOpenOnUnreachableRedis(): Promise<{
  allowed: boolean;
  degraded: boolean;
  elapsedMs: number;
}> {
  // Port 1 is never a real Redis — the EVAL call rejects, exercising the fail-open branch.
  const limiter = createSlidingWindowRateLimiter({
    connection: { redisUrl: 'redis://127.0.0.1:1' },
    bucketKeyPrefix: 'probe:sliding-window:unreachable',
    limit: 1,
    windowMs: 1_000,
  });
  // Elapsed time is part of the proof, not diagnostics: fail-open exists so
  // a Redis outage does not become an origin outage, which only holds if the call is BOUNDED.
  // Unbounded, this took ~30s per request on an inbound path. The suite asserts a ceiling.
  const startedAt = Date.now();
  const decision = await limiter.tryAcquire('subject-c');
  const elapsedMs = Date.now() - startedAt;
  await limiter.close();
  return { allowed: decision.allowed, degraded: decision.degraded, elapsedMs };
}

async function main(): Promise<void> {
  const burst = await burstExhaustion();
  const windowExpiry = await windowExpiryReadmits();
  const concurrency = await concurrentNeverOverAdmits();
  const failOpen = await failOpenOnUnreachableRedis();
  process.stdout.write(`${JSON.stringify({ burst, windowExpiry, concurrency, failOpen })}\n`);
}

await main();
// `failOpenOnUnreachableRedis`'s client never completes a real handshake, and Bun's RedisClient
// can leave a lingering reconnect-adjacent timer alive even after `close()` and after
// `tryAcquire` itself has long since resolved — the OTHER probes in this suite never hit this
// (their bucket connects to a real, reachable Redis) — so this probe forces the exit explicitly
// rather than relying on natural event-loop drain (verified: without this, the harness's
// `runProbe` timeout fires even though `main()` above already completed and printed its result).
process.exit(0);
