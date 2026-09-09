import { ERROR_CODE, isAppError, RateLimitedError } from '@repo/kernel';
import {
  createSlidingWindowRateLimiter,
  type MessagingConnection,
  type SlidingWindowRateLimiter,
} from '@repo/messaging';
import {
  createModuleObservability,
  type InstrumentSpecification,
  METRIC_ATTRIBUTE,
} from '@repo/observability';

/** ADR-0013's security baseline — frozen. Checked in this order, first applicable wins (one
 * limiter consultation per request). This product's session model has no tenant dimension
 * (ADR-0013), so the buckets below are keyed by client IP only: every `/api/auth/*` request, and
 * every POST carrying no resolved session. */
export const RATE_LIMIT_BUCKET = {
  Auth: 'auth', // every /api/auth/* request, keyed by client IP
  UnauthenticatedPost: 'unauthenticated-post', // POST with no session, keyed by client IP
} as const;
export type RateLimitBucket = (typeof RATE_LIMIT_BUCKET)[keyof typeof RATE_LIMIT_BUCKET];

const obs = createModuleObservability('api');

/** `api.http.rate-limited`: one tick per 429; Queue = the bucket. */
export const API_HTTP_RATE_LIMITED_INSTRUMENT: InstrumentSpecification = {
  name: 'api.http.rate-limited',
  allowedAttributes: [METRIC_ATTRIBUTE.Queue],
};
const rateLimitedCounter = obs.createCounter(API_HTTP_RATE_LIMITED_INSTRUMENT);

/** `api.http.rate-limit-degraded`: one tick per fail-open allow. */
export const API_HTTP_RATE_LIMIT_DEGRADED_INSTRUMENT: InstrumentSpecification = {
  name: 'api.http.rate-limit-degraded',
  allowedAttributes: [METRIC_ATTRIBUTE.Queue],
};
const rateLimitDegradedCounter = obs.createCounter(API_HTTP_RATE_LIMIT_DEGRADED_INSTRUMENT);

export interface RateLimitPolicyConfig {
  readonly authPerMinute: number;
  readonly unauthenticatedPostPerMinute: number;
  /** `HTTP_TRUST_PROXY`: only trust `X-Forwarded-For`'s first hop when a reverse proxy actually
   * sits in front — trusting the header from a direct connection is spoofable. */
  readonly trustProxy: boolean;
}

const ONE_MINUTE_MS = 60_000;

export interface RateLimiters {
  close(): Promise<void>;
  /** Bucket 1: every `/api/auth/*` request, keyed by client IP. Call from the `/api/auth/*`
   * route, before delegating to better-auth's handler. */
  checkAuth(request: Request): Promise<void>;
  /** Bucket 2: a POST with NO resolved session, keyed by client IP. Call once the per-request
   * session is known (header-only resolution — still "before body parsing": the oRPC handler's
   * own JSON body parse happens strictly after this). */
  checkUnauthenticatedPost(request: Request): Promise<void>;
}

/** A shared subject-key fallback for a direct (non-proxied) connection: with no reachable client
 * IP (this app's `.mount()`-based routing has no path to the underlying socket, and
 * `HTTP_TRUST_PROXY` is off), every direct client shares one bucket rather than the check being
 * skipped outright — a coarser limit is the fail-toward-restrictive direction; a reverse proxy in
 * front is what actually sets `HTTP_TRUST_PROXY=true` and restores per-IP granularity.
 */
const DIRECT_CONNECTION_SUBJECT = 'direct';

function clientIpOf(request: Request, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers.get('x-forwarded-for');
    const firstHop = forwarded?.split(',')[0]?.trim();
    if (firstHop !== undefined && firstHop.length > 0) {
      return firstHop;
    }
  }
  return DIRECT_CONNECTION_SUBJECT;
}

async function enforce(
  limiter: SlidingWindowRateLimiter,
  bucket: RateLimitBucket,
  subjectKey: string,
): Promise<void> {
  const decision = await limiter.tryAcquire(subjectKey);
  if (decision.degraded) {
    rateLimitDegradedCounter.add(1, { queue: bucket });
  }
  if (!decision.allowed) {
    rateLimitedCounter.add(1, { queue: bucket });
    throw new RateLimitedError(`rate limit exceeded for bucket "${bucket}"`, {
      details: { bucket, retryAfterMs: decision.retryAfterMs },
    });
  }
}

/** Adds a `Retry-After` header (a denied request gets one, computed from `retryAfterMs`) when
 * `error` is the `RateLimitedError` {@link enforce} throws — a no-op for anything else, so
 * callers can pipe every mapped error response through this unconditionally. */
export function withRetryAfterHeader(response: Response, error: unknown): Response {
  if (!isAppError(error) || error.code !== ERROR_CODE.RateLimited) {
    return response;
  }
  const details = error.details as { readonly retryAfterMs?: number } | undefined;
  if (typeof details?.retryAfterMs !== 'number') {
    return response;
  }
  const headers = new Headers(response.headers);
  headers.set('Retry-After', String(Math.ceil(details.retryAfterMs / 1000)));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** Builds the two sliding-window limiters the policy needs — one per bucket, so an exhausted Auth
 * bucket never borrows capacity from UnauthenticatedPost or vice versa. */
export function createRateLimiters(options: {
  readonly connection: MessagingConnection;
  readonly config: RateLimitPolicyConfig;
}): RateLimiters {
  const auth = createSlidingWindowRateLimiter({
    connection: options.connection,
    bucketKeyPrefix: 'rate-limit:http:auth',
    limit: options.config.authPerMinute,
    windowMs: ONE_MINUTE_MS,
  });
  const unauthenticatedPost = createSlidingWindowRateLimiter({
    connection: options.connection,
    bucketKeyPrefix: 'rate-limit:http:unauthenticated-post',
    limit: options.config.unauthenticatedPostPerMinute,
    windowMs: ONE_MINUTE_MS,
  });

  return {
    async close(): Promise<void> {
      await Promise.all([auth.close(), unauthenticatedPost.close()]);
    },
    async checkAuth(request: Request): Promise<void> {
      await enforce(auth, RATE_LIMIT_BUCKET.Auth, clientIpOf(request, options.config.trustProxy));
    },
    async checkUnauthenticatedPost(request: Request): Promise<void> {
      await enforce(
        unauthenticatedPost,
        RATE_LIMIT_BUCKET.UnauthenticatedPost,
        clientIpOf(request, options.config.trustProxy),
      );
    },
  };
}
