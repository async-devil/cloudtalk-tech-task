import { describe, expect, it } from 'vitest';
import { createSlidingWindowRateLimiter } from '../src/sliding-window-rate-limiter.js';

const CONNECTION = { redisUrl: 'redis://localhost:0' };

describe('createSlidingWindowRateLimiter option validation (wi-11 spec §3)', () => {
  it('rejects a non-positive limit', () => {
    expect(() =>
      createSlidingWindowRateLimiter({
        connection: CONNECTION,
        bucketKeyPrefix: 'test',
        limit: 0,
        windowMs: 1000,
      }),
    ).toThrow();
  });

  it('rejects a fractional limit', () => {
    expect(() =>
      createSlidingWindowRateLimiter({
        connection: CONNECTION,
        bucketKeyPrefix: 'test',
        limit: 1.5,
        windowMs: 1000,
      }),
    ).toThrow();
  });

  it('rejects a non-positive windowMs', () => {
    expect(() =>
      createSlidingWindowRateLimiter({
        connection: CONNECTION,
        bucketKeyPrefix: 'test',
        limit: 10,
        windowMs: -1,
      }),
    ).toThrow();
  });
});
