import type { MessagingConnection } from './connection.js';
import { rpmLimiterOptions } from './internal/rpm-limiter-options.js';
import { TOKEN_BUCKET_LUA } from './internal/token-bucket-lua.js';

/** Options accepted by {@link createTokenBucketRateLimiter} (frozen). */
export interface TokenBucketOptions {
  readonly connection: MessagingConnection;
  /** Caller-namespaced Redis key, e.g. `'rate-limit:openai'`. One bucket per key. */
  readonly bucketKey: string;
  /** Max burst (integer > 0). */
  readonly capacity: number;
  /** Tokens/second (> 0, fractional allowed). */
  readonly refillPerSecond: number;
}

export interface TokenBucketDecision {
  readonly allowed: boolean;
  readonly remainingTokens: number;
  /** 0 when allowed; otherwise the shortest wait until `cost` tokens exist. Callers decide what
   * to do with it — there is deliberately NO blocking acquire (an open-ended wait inside a
   * worker step is the hidden-latency class ADR-0007's shape exists to keep visible). */
  readonly retryAfterMs: number;
}

export interface RateLimiter {
  tryAcquire(cost?: number): Promise<TokenBucketDecision>;
  close(): Promise<void>;
}

const DEFAULT_COST = 1;

/**
 * The Redis-Lua token bucket (ADR-0005: the provider-side limiter composition roots
 * wrap paid ports with). One `EVAL` per `tryAcquire` — atomic, so two concurrent callers against
 * one bucket never over-admit. Own raw `Bun.RedisClient` — this is provider-throttling, not a
 * BullMQ queue/worker, so it bypasses `bunRedisConnection`'s BullMQ adapter entirely.
 */
export function createTokenBucketRateLimiter(options: TokenBucketOptions): RateLimiter {
  const raw = new globalThis.Bun.RedisClient(options.connection.redisUrl);

  return {
    async tryAcquire(cost = DEFAULT_COST): Promise<TokenBucketDecision> {
      const result = await raw.send<[number, string, number]>('EVAL', [
        TOKEN_BUCKET_LUA,
        '1',
        options.bucketKey,
        String(options.capacity),
        String(options.refillPerSecond),
        String(cost),
      ]);
      const [allowed, remainingTokens, retryAfterMs] = result;
      return { allowed: allowed === 1, remainingTokens: Number(remainingTokens), retryAfterMs };
    },
    close(): Promise<void> {
      raw.close();
      return Promise.resolve();
    },
  };
}

/** Convenience: `capacity = requestsPerMinute`, `refillPerSecond = requestsPerMinute / 60`
 *. */
export function createRequestsPerMinuteRateLimiter(options: {
  readonly connection: MessagingConnection;
  readonly bucketKey: string;
  readonly requestsPerMinute: number;
}): RateLimiter {
  return createTokenBucketRateLimiter({
    connection: options.connection,
    bucketKey: options.bucketKey,
    ...rpmLimiterOptions(options.requestsPerMinute),
  });
}

/** The refill math, exported PURE so 's unit-pins exactly the formula the Lua
 * embeds — integration proves the two agree against real Redis. */
export function computeTokenBucketRefill(state: {
  readonly tokens: number;
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly elapsedMs: number;
}): number {
  return Math.min(state.capacity, state.tokens + (state.elapsedMs * state.refillPerSecond) / 1000);
}
