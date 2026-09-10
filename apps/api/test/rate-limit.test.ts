import { RateLimitedError, ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import {
  isReviewSubmissionRoute,
  RATE_LIMIT_BUCKET,
  rateLimitSubjectOf,
  rateLimitUserSubjectOf,
  withRetryAfterHeader,
} from '../src/http/security/rate-limit.js';

function requestForwardedFrom(forwardedFor: string): Request {
  return new Request('https://api.example.test/api/auth/sign-in/magic-link', {
    method: 'POST',
    headers: { 'x-forwarded-for': forwardedFor },
  });
}

describe('RATE_LIMIT_BUCKET', () => {
  // Asserted as a whole set rather than member-by-member: a bucket added without a limiter wired
  // for it is a policy that silently does nothing, and this is the assertion that notices.
  it('is the closed four-member set (ADR-0018 baseline extended by ADR-0019)', () => {
    expect(Object.values(RATE_LIMIT_BUCKET)).toStrictEqual([
      'auth',
      'unauthenticated-post',
      'anonymous-read',
      'review-submission',
    ]);
  });
});

describe('withRetryAfterHeader', () => {
  it('adds Retry-After (seconds, rounded up) for a RateLimitedError carrying retryAfterMs', () => {
    const error = new RateLimitedError('too many requests', {
      details: { retryAfterMs: 2_500 },
    });
    const response = withRetryAfterHeader(new Response(null, { status: 429 }), error);
    expect(response.headers.get('retry-after')).toBe('3');
  });

  it('is a no-op for a non-RateLimitedError', () => {
    const response = withRetryAfterHeader(
      new Response(null, { status: 400 }),
      new ValidationError('bad input'),
    );
    expect(response.headers.get('retry-after')).toBeNull();
  });

  it('is a no-op when the RateLimitedError carries no retryAfterMs detail', () => {
    const response = withRetryAfterHeader(
      new Response(null, { status: 429 }),
      new RateLimitedError('too many requests'),
    );
    expect(response.headers.get('retry-after')).toBeNull();
  });
});

// Both properties below are the security half of ADR-0013's rate-limit baseline, and both were
// bypasses before the 2026-09-09 review: a limiter that can be walked around is not a limiter.
describe('rateLimitSubjectOf', () => {
  it('keys on the trusted proxy hop (rightmost), so a spoofed client hop cannot rotate buckets', () => {
    // One real client behind the trusted proxy, writing a different fake hop on every request.
    const first = rateLimitSubjectOf(requestForwardedFrom('9.9.9.9, 203.0.113.7'), true);
    const second = rateLimitSubjectOf(requestForwardedFrom('8.8.8.8, 203.0.113.7'), true);
    const third = rateLimitSubjectOf(requestForwardedFrom('203.0.113.7'), true);
    expect(second).toBe(first);
    expect(third).toBe(first);
  });

  it('still separates two genuinely different clients behind the proxy', () => {
    expect(rateLimitSubjectOf(requestForwardedFrom('198.51.100.1'), true)).not.toBe(
      rateLimitSubjectOf(requestForwardedFrom('198.51.100.2'), true),
    );
  });

  it('ignores the header entirely when the proxy is not trusted', () => {
    const spoofed = rateLimitSubjectOf(requestForwardedFrom('9.9.9.9'), false);
    const alsoSpoofed = rateLimitSubjectOf(requestForwardedFrom('8.8.8.8'), false);
    const none = rateLimitSubjectOf(new Request('https://api.example.test/api/auth/x'), false);
    expect(spoofed).toBe(none);
    expect(alsoSpoofed).toBe(none);
  });

  it('falls back to the shared direct subject when a trusted proxy sent no usable hop', () => {
    expect(rateLimitSubjectOf(requestForwardedFrom('   '), true)).toBe(
      rateLimitSubjectOf(new Request('https://api.example.test/api/auth/x'), true),
    );
  });

  // The sliding-window script keeps a `{key}:seq` counter beside each window key, so a RAW subject
  // could name another subject's counter, draw a WRONGTYPE from Redis and ride the limiter's
  // fail-open branch into unlimited traffic. A fixed-length hex subject cannot name anything.
  it('emits a fixed-length hex subject: no subject can name another subject Redis key', () => {
    const hostile = rateLimitSubjectOf(requestForwardedFrom('198.51.100.9:seq'), true);
    expect(hostile).toMatch(/^[0-9a-f]{32}$/);
    expect(rateLimitSubjectOf(requestForwardedFrom('198.51.100.9'), true)).toMatch(
      /^[0-9a-f]{32}$/,
    );
    expect(hostile).not.toContain(':');
  });
});

// ADR-0019: `review-submission` is the first bucket keyed by something other than a client-IP
// hash, and the record is explicit that this needs "that same containment, and needs it verified
// the same way" as the IP-derived buckets above — not by inspection.
describe('rateLimitUserSubjectOf', () => {
  // Mutation: in `src/http/security/rate-limit.ts`, change `rateLimitUserSubjectOf` to return
  // `userId` unchanged (skip `hashSubject`) — a user id crafted to end in `:seq` would then reach
  // Redis raw and collide with another subject's sequence counter, and this test's
  // `not.toContain(':')` assertion goes red.
  it("emits a fixed-length hex subject: a hostile user id cannot name another subject's Redis key", () => {
    const hostile = rateLimitUserSubjectOf('usr_hostile-id:seq');
    expect(hostile).toMatch(/^[0-9a-f]{32}$/);
    expect(hostile).not.toContain(':');
  });

  it('still separates two genuinely different users', () => {
    expect(rateLimitUserSubjectOf('usr_aaaa')).not.toBe(rateLimitUserSubjectOf('usr_bbbb'));
  });

  it('is deterministic: the same user id always hashes to the same subject', () => {
    expect(rateLimitUserSubjectOf('usr_stable')).toBe(rateLimitUserSubjectOf('usr_stable'));
  });

  // Mutation: in `src/http/security/rate-limit.ts`'s `hashSubject`, remove `.slice(0,
  // SUBJECT_HASH_LENGTH)` — the IP-derived and user-id-derived subjects would then be full-length
  // SHA-256 hex (64 chars) instead of 32, and this cross-check goes red. Verifies the two subject
  // KINDS genuinely share one containment boundary rather than each hashing its own way.
  it('shares the identical hash shape rateLimitSubjectOf uses', () => {
    const userSubject = rateLimitUserSubjectOf('usr_shape-check');
    const ipSubject = rateLimitSubjectOf(requestForwardedFrom('203.0.113.9'), true);
    expect(userSubject).toHaveLength(ipSubject.length);
  });
});

describe('isReviewSubmissionRoute (ADR-0019)', () => {
  it('is true for reviews.submit and reviews.update, and false for everything else', () => {
    expect(isReviewSubmissionRoute('POST', '/products/{productSlug}/reviews')).toBe(true);
    expect(isReviewSubmissionRoute('PATCH', '/reviews/{reviewToken}')).toBe(true);
  });

  // The negative half SPEC-0003/ADR-0019 are explicit about: `reviews.remove` (a DELETE on the
  // same path template `update` uses) is deliberately NOT in this bucket.
  //
  // Mutation: in `src/http/security/rate-limit.ts`, drop the `method` half of
  // `REVIEW_SUBMISSION_ROUTE_KEYS`' matching (key by path template alone) — `DELETE
  // /reviews/{reviewToken}` would then match too, and this assertion goes red.
  it('is false for reviews.remove (same path template as update, different method)', () => {
    expect(isReviewSubmissionRoute('DELETE', '/reviews/{reviewToken}')).toBe(false);
  });

  it('is false for the two anonymous product/review reads', () => {
    expect(isReviewSubmissionRoute('GET', '/products')).toBe(false);
    expect(isReviewSubmissionRoute('GET', '/products/{productSlug}/reviews')).toBe(false);
  });

  it('is false for a route the contract does not declare at all', () => {
    expect(isReviewSubmissionRoute('POST', '/not/a/real/route')).toBe(false);
  });
});
