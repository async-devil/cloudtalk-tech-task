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
import { assertDeclaredRouteKeys, routeKeyOf } from '../route-template.js';

/** The rate-limit bucket list, per the security baseline ADR-0018 restated it (unchanged from
 * ADR-0013 via ADR-0017 — neither superseding record touches this list; ADR-0018 is the one to
 * cite as its authority, not the twice-superseded ADR-0013), EXTENDED by ADR-0019 with two more.
 * Checked in this order, first applicable wins (one limiter consultation per request). This
 * product's session model has no tenant dimension (ADR-0013), so the first two buckets are keyed
 * by client IP only; ADR-0019's `anonymous-read` is keyed the same way (a `GET` carries no
 * identity to key on), while `review-submission` is the first bucket keyed by something else — the
 * session's own internal user id — because it is the one case where an identity IS available. */
export const RATE_LIMIT_BUCKET = {
  Auth: 'auth', // every /api/auth/* request, keyed by client IP
  UnauthenticatedPost: 'unauthenticated-post', // POST with no session, keyed by client IP
  AnonymousRead: 'anonymous-read', // GET with no session, keyed by client IP (ADR-0019)
  ReviewSubmission: 'review-submission', // reviews.submit/update with a session, keyed by userId (ADR-0019)
} as const;
export type RateLimitBucket = (typeof RATE_LIMIT_BUCKET)[keyof typeof RATE_LIMIT_BUCKET];

/**
 * The exact route keys `review-submission` covers (ADR-0019): `reviews.submit` and
 * `reviews.update`, and NOTHING else — `reviews.remove` is deliberately excluded (SPEC-0003's own
 * bucket list omits it; a deletion is not the traffic shape either bucket exists to bound).
 * Validated against the real contract below at module load, so a route rename that this literal
 * list falls out of step with fails at BOOT rather than silently limiting nothing (this app's own
 * README INV-6, until now unwired — `test/route-template.test.ts` proves the guard works in
 * isolation; this is where it is actually wired to something).
 */
const REVIEW_SUBMISSION_ROUTE_KEYS: readonly string[] = [
  routeKeyOf('POST', '/products/{productSlug}/reviews'),
  routeKeyOf('PATCH', '/reviews/{reviewToken}'),
];
assertDeclaredRouteKeys(REVIEW_SUBMISSION_ROUTE_KEYS);
const REVIEW_SUBMISSION_ROUTE_KEY_SET = new Set(REVIEW_SUBMISSION_ROUTE_KEYS);

/** Whether `method`+`routeTemplate` is one of the two routes the `review-submission` bucket
 * covers — the `http/index.ts` call site's whole reason to import this file's route-template
 * dependency instead of restating the two strings itself. */
export function isReviewSubmissionRoute(method: string, routeTemplate: string): boolean {
  return REVIEW_SUBMISSION_ROUTE_KEY_SET.has(routeKeyOf(method, routeTemplate));
}

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
  /** ADR-0019 bucket 3. */
  readonly anonymousReadPerMinute: number;
  /** ADR-0019 bucket 4. */
  readonly reviewSubmissionPerMinute: number;
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
  /** Bucket 3 (ADR-0019): a GET with NO resolved session, keyed by client IP — every anonymous
   * catalogue/product/review-list read. Same placement precedent as bucket 2. */
  checkAnonymousRead(request: Request): Promise<void>;
  /** Bucket 4 (ADR-0019): `reviews.submit`/`reviews.update` with a RESOLVED session, keyed by the
   * session's internal user id — never an IP, and never logged or placed on a metric attribute
   * (ADR-0009). Call only once `isReviewSubmissionRoute` confirms the route; the id itself is
   * hashed the same containment way {@link rateLimitSubjectOf} hashes an IP. */
  checkReviewSubmission(userId: string): Promise<void>;
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
 * The containment hash every subject key goes through before it ever reaches Redis (review,
 * 2026-09-09) — factored out so {@link rateLimitSubjectOf} (an IP-derived subject) and
 * {@link rateLimitUserSubjectOf} (ADR-0019's internal-id subject) share the identical guarantee
 * rather than each hashing its own way.
 *
 * The hash is a containment boundary, not obfuscation. The subject is interpolated into the
 * limiter's Redis key, and the sliding-window script keeps a companion `{key}:seq` counter beside
 * the window ZSET. A raw subject is therefore free to name another subject's internal key — a
 * subject ending in `:seq` collides with the counter of the subject before it, Redis answers
 * `WRONGTYPE`, and the limiter's fail-open branch turns that into an unlimited allow for whoever
 * chose the value. Hashing to a fixed-length hex string makes the subject portion of the key
 * structurally incapable of naming anything but itself.
 */
function hashSubject(raw: string): string {
  return createHash('sha256').update(raw).digest('hex').slice(0, SUBJECT_HASH_LENGTH);
}

/**
 * The limiter subject key for a request: the trusted-proxy hop above, HASHED.
 *
 * Exported for `test/rate-limit.test.ts`: both containment properties {@link hashSubject}
 * documents are security properties, so they are asserted directly rather than inferred from a
 * limiter's behaviour.
 */
export function rateLimitSubjectOf(request: Request, trustProxy: boolean): string {
  return hashSubject(forwardedForSubjectOf(request, trustProxy));
}

/**
 * The limiter subject key for `review-submission` (ADR-0019): a resolved session's internal
 * `userId`, HASHED through the same {@link hashSubject} containment boundary every IP-derived
 * subject already goes through — the record's own words: "needs that same containment, and needs
 * it verified the same way." Exported for `test/rate-limit.test.ts` for the identical reason
 * {@link rateLimitSubjectOf} is.
 */
export function rateLimitUserSubjectOf(userId: string): string {
  return hashSubject(userId);
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

/** Builds the four sliding-window limiters the policy needs — one per bucket, so an exhausted
 * bucket never borrows capacity from any other (ADR-0018, extended by ADR-0019). */
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
  const anonymousRead = createSlidingWindowRateLimiter({
    connection: options.connection,
    bucketKeyPrefix: 'rate-limit:http:anonymous-read',
    limit: options.config.anonymousReadPerMinute,
    windowMs: ONE_MINUTE_MS,
  });
  const reviewSubmission = createSlidingWindowRateLimiter({
    connection: options.connection,
    bucketKeyPrefix: 'rate-limit:http:review-submission',
    limit: options.config.reviewSubmissionPerMinute,
    windowMs: ONE_MINUTE_MS,
  });

  return {
    async close(): Promise<void> {
      await Promise.all([
        auth.close(),
        unauthenticatedPost.close(),
        anonymousRead.close(),
        reviewSubmission.close(),
      ]);
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
    async checkAnonymousRead(request: Request): Promise<void> {
      await enforce(
        anonymousRead,
        RATE_LIMIT_BUCKET.AnonymousRead,
        rateLimitSubjectOf(request, options.config.trustProxy),
      );
    },
    async checkReviewSubmission(userId: string): Promise<void> {
      await enforce(
        reviewSubmission,
        RATE_LIMIT_BUCKET.ReviewSubmission,
        rateLimitUserSubjectOf(userId),
      );
    },
  };
}
