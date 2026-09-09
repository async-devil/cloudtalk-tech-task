import { createHash } from 'node:crypto';
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
  /** `HTTP_TRUST_PROXY`: only read `X-Forwarded-For` at all when a reverse proxy actually sits in
   * front — the header is client-writable, so on a direct connection every hop in it is a
   * fiction. Even with the flag on, only the hop the trusted proxy itself appended is used (see
   * {@link rateLimitSubjectOf}). */
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

/** How much of the subject hash is kept. 128 bits of SHA-256 hex: collision-free in practice for
 * a keyspace of client IPs, and short enough that a Redis key stays cheap. */
const SUBJECT_HASH_LENGTH = 32;

/**
 * The address the TRUSTED PROXY observed, i.e. `X-Forwarded-For`'s RIGHTMOST hop — never the
 * leftmost one (review, 2026-09-09).
 *
 * `X-Forwarded-For` is appended to left-to-right, so the leftmost entry is whatever the original
 * client wrote and the rightmost is the only entry the proxy in front of us produced itself.
 * Keying on the leftmost hop hands every client its own bucket namespace: rotate the header value
 * per request and each request lands in a fresh, empty window — the limiter is bypassed outright
 * while still appearing to work. The rightmost hop cannot be forged that way, because the trusted
 * proxy overwrites that position with the peer address it actually accepted the connection from.
 *
 * This assumes EXACTLY ONE trusted proxy in front of the app, which is what `HTTP_TRUST_PROXY`
 * asserts (deploy topology, ADR-0013). Chaining a second proxy without teaching this function how
 * many hops to skip would key on the inner proxy's address and collapse all traffic onto one
 * bucket — coarser, i.e. the fail-toward-restrictive direction, never a bypass.
 */
function forwardedForSubjectOf(request: Request, trustProxy: boolean): string {
  if (!trustProxy) {
    return DIRECT_CONNECTION_SUBJECT;
  }
  const hops = request.headers.get('x-forwarded-for')?.split(',') ?? [];
  const proxyHop = hops.at(-1)?.trim();
  return proxyHop !== undefined && proxyHop.length > 0 ? proxyHop : DIRECT_CONNECTION_SUBJECT;
}

/**
 * The limiter subject key for a request: the trusted-proxy hop above, HASHED.
 *
 * The hash is a containment boundary, not obfuscation (review, 2026-09-09). The subject is
 * interpolated into the limiter's Redis key, and the sliding-window script keeps a companion
 * `{key}:seq` counter beside the window ZSET. A raw subject is therefore free to name another
 * subject's internal key — a subject ending in `:seq` collides with the counter of the subject
 * before it, Redis answers `WRONGTYPE`, and the limiter's fail-open branch turns that into an
 * unlimited allow for whoever chose the value. Hashing to a fixed-length hex string makes the
 * subject portion of the key structurally incapable of naming anything but itself.
 *
 * Exported for `test/rate-limit.test.ts`: both properties above are security properties, so they
 * are asserted directly rather than inferred from a limiter's behaviour.
 */
export function rateLimitSubjectOf(request: Request, trustProxy: boolean): string {
  return createHash('sha256')
    .update(forwardedForSubjectOf(request, trustProxy))
    .digest('hex')
    .slice(0, SUBJECT_HASH_LENGTH);
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
      await enforce(
        auth,
        RATE_LIMIT_BUCKET.Auth,
        rateLimitSubjectOf(request, options.config.trustProxy),
      );
    },
    async checkUnauthenticatedPost(request: Request): Promise<void> {
      await enforce(
        unauthenticatedPost,
        RATE_LIMIT_BUCKET.UnauthenticatedPost,
        rateLimitSubjectOf(request, options.config.trustProxy),
      );
    },
  };
}
