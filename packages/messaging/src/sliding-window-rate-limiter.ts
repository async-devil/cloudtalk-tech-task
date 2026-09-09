import { ValidationError } from '@repo/kernel';
import { createModuleObservability } from '@repo/observability';
import type { MessagingConnection } from './connection.js';
import { createIntervalSuppressor } from './internal/log-suppressor.js';
import { SLIDING_WINDOW_LUA } from './internal/sliding-window-lua.js';

const obs = createModuleObservability('messaging');

/** Options accepted by {@link createSlidingWindowRateLimiter}. */
export interface SlidingWindowOptions {
  readonly connection: MessagingConnection;
  /** Namespaces the Redis keys, e.g. 'rate-limit:http:auth'. One window per (prefix, subject). */
  readonly bucketKeyPrefix: string;
  readonly limit: number; // max events per window (integer > 0)
  readonly windowMs: number;
}

export interface SlidingWindowDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly retryAfterMs: number; // 0 when allowed
  /** true when a Redis failure forced the fail-open allow — callers tick the degraded
   * counter so "limiter currently unlimited" is alertable, not just warned. */
  readonly degraded: boolean;
}

export interface SlidingWindowRateLimiter {
  tryAcquire(subjectKey: string): Promise<SlidingWindowDecision>;
  close(): Promise<void>;
}

/** A decision this limiter never actually admits/denies against Redis — used only on the
 * fail-open path: unlimited allow, undefined remaining, no retry. */
const FAIL_OPEN_DECISION: SlidingWindowDecision = {
  allowed: true,
  remaining: Number.POSITIVE_INFINITY,
  retryAfterMs: 0,
  degraded: true,
};

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValidationError(`createSlidingWindowRateLimiter: ${name} must be an integer > 0`);
  }
}

/**
 * Hard deadline for one `EVAL`, and the reason fail-open is worth having (block review,
 * 2026-07-27).
 *
 * Without it, `tryAcquire` inherits Bun's own reconnect/backoff budget against an unreachable
 * Redis — empirically ~30s (see the constructor note below). Since this limiter sits on the
 * inbound HTTP path and is awaited BEFORE the request is served, that turns "Redis is down" into
 * a ~30s stall on every single request: connections pile up and the origin is effectively down.
 * That is precisely the "cache outage becomes a full outage" failure the fail-open branch exists
 * to prevent, so an unbounded call defeats its own mitigation.
 *
 * 250ms is ~3 orders of magnitude above a healthy round trip (sub-millisecond against a local or
 * same-VPC Redis), so a healthy path never sees it; an unhealthy one degrades in a quarter second
 * instead of half a minute. A module constant rather than a config key deliberately: the spec
 * names no such key, and this is a liveness floor rather than a tuning knob.
 *
 * Bounding an external call this way follows 's `awsSecretsManagerSource`, which is likewise
 * deadline-bounded with no retries.
 */
const REDIS_CALL_DEADLINE_MS = 250;

/** Rejects if `operation` outruns {@link REDIS_CALL_DEADLINE_MS}. The losing promise gets a
 * no-op `catch` so a late Redis rejection never surfaces as an unhandled rejection after the race
 * has already been decided. */
async function withDeadline<T>(operation: Promise<T>, label: string): Promise<T> {
  operation.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label}: exceeded ${REDIS_CALL_DEADLINE_MS}ms deadline`)),
      REDIS_CALL_DEADLINE_MS,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Redis-Lua sliding-window limiter — the sibling of the token bucket in
 * the same rate-limiter family — per-IP/route buckets (measure 1's HTTP shape) rather than the
 * token bucket's per-tenant cost shaping. One `EVAL` per `tryAcquire`, atomic (never over-admits
 * under concurrency). Own raw `Bun.RedisClient`, same as `createTokenBucketRateLimiter`.
 *
 * Fail-open is NOT silent (): a Redis failure inside `tryAcquire` resolves
 * `{ allowed: true, degraded: true }` and warns once-per-interval — an
 * origin that hard-fails closed on a Redis blip turns a cache outage into a full outage, which is
 * a worse default than brief unlimited traffic. Callers MUST tick their own degraded counter
 * (`api.http.rate-limit-degraded`) on `decision.degraded === true` — this module has no HTTP
 * vocabulary of its own to name the bucket attribute with.
 */
export function createSlidingWindowRateLimiter(
  options: SlidingWindowOptions,
): SlidingWindowRateLimiter {
  assertPositiveInteger(options.limit, 'limit');
  assertPositiveInteger(options.windowMs, 'windowMs');

  // finding, reported: several bounded-connection option combinations were tried here
  // (short `connectionTimeout`/`maxRetries`, `autoReconnect: false`, an `onclose` no-op) to make
  // the fail-open path (below) resolve promptly against a genuinely unreachable Redis. Every
  // deviation from Bun's OWN defaults reproduced a WORSE failure under this repo's real
  // Testcontainers suites — `autoReconnect: false` in particular crashed the whole process on an
  // ordinary reconnect under heavy parallel container load (`ERR_REDIS_CONNECTION_CLOSED`
  // surfacing as an unhandled error), the exact "cache outage becomes a full outage" class this
  // limiter's fail-open exists to prevent. Bun's bare defaults (matching
  // `createTokenBucketRateLimiter`'s own bare constructor call exactly) do not crash.
  //
  // Bun's defaults alone would leave `tryAcquire` waiting out that reconnect/backoff budget
  // (~30s) against an unreachable host before the catch below could convert it to a fail-open
  // decision. The block review (2026-07-27) ruled that unacceptable on an inbound-request
  // path — see REDIS_CALL_DEADLINE_MS above — so the client keeps Bun's safe defaults while the
  // CALL is deadline-bounded instead. `packages/messaging/test-integration/probes/
  // sliding-window.probe.ts`'s fail-open case asserts the bounded latency, not just the decision.
  const raw = new globalThis.Bun.RedisClient(options.connection.redisUrl);
  const warnOnce = createIntervalSuppressor();

  return {
    async tryAcquire(subjectKey: string): Promise<SlidingWindowDecision> {
      try {
        const result = await withDeadline(
          raw.send<[number, number, number]>('EVAL', [
            SLIDING_WINDOW_LUA,
            '1',
            `${options.bucketKeyPrefix}:${subjectKey}`,
            String(options.limit),
            String(options.windowMs),
          ]),
          'messaging.sliding-window',
        );
        const [allowed, remaining, retryAfterMs] = result;
        return {
          allowed: allowed === 1,
          remaining: Number(remaining),
          retryAfterMs: Number(retryAfterMs),
          degraded: false,
        };
      } catch (error) {
        warnOnce(obs.logger, 'messaging.sliding-window: fail-open on Redis error', {
          bucketKeyPrefix: options.bucketKeyPrefix,
          cause: String(error),
        });
        return FAIL_OPEN_DECISION;
      }
    },
    close(): Promise<void> {
      raw.close();
      return Promise.resolve();
    },
  };
}
