import { RateLimitedError, ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import {
  RATE_LIMIT_BUCKET,
  rateLimitSubjectOf,
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
