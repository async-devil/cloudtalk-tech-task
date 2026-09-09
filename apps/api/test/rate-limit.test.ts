import { RateLimitedError, ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import { RATE_LIMIT_BUCKET, withRetryAfterHeader } from '../src/http/security/rate-limit.js';

describe('RATE_LIMIT_BUCKET', () => {
  // Asserted as a whole set rather than member-by-member: a bucket added without a limiter wired
  // for it is a policy that silently does nothing, and this is the assertion that notices.
  it('is the closed two-member set', () => {
    expect(Object.values(RATE_LIMIT_BUCKET)).toStrictEqual(['auth', 'unauthenticated-post']);
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
