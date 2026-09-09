import { describe, expect, it } from 'vitest';
import { rpmLimiterOptions } from '../src/internal/rpm-limiter-options.js';
import { computeTokenBucketRefill } from '../src/rate-limiter.js';

describe('computeTokenBucketRefill (frozen formula)', () => {
  it('caps refill at capacity', () => {
    expect(
      computeTokenBucketRefill({ tokens: 9, capacity: 10, refillPerSecond: 5, elapsedMs: 5000 }),
    ).toBe(10);
  });

  it('zero elapsed time adds nothing', () => {
    expect(
      computeTokenBucketRefill({ tokens: 3, capacity: 10, refillPerSecond: 1, elapsedMs: 0 }),
    ).toBe(3);
  });

  it('fractional refill within capacity', () => {
    expect(
      computeTokenBucketRefill({ tokens: 1, capacity: 10, refillPerSecond: 2, elapsedMs: 500 }),
    ).toBe(2);
  });

  it('large elapsed time still caps at capacity', () => {
    expect(
      computeTokenBucketRefill({
        tokens: 0,
        capacity: 5,
        refillPerSecond: 1,
        elapsedMs: 1_000_000,
      }),
    ).toBe(5);
  });

  it('tokens already above capacity clamp to capacity', () => {
    expect(
      computeTokenBucketRefill({
        tokens: 15,
        capacity: 10,
        refillPerSecond: 1,
        elapsedMs: 1000,
      }),
    ).toBe(10);
  });

  it('fractional refillPerSecond like 0.5', () => {
    expect(
      computeTokenBucketRefill({
        tokens: 0,
        capacity: 10,
        refillPerSecond: 0.5,
        elapsedMs: 2000,
      }),
    ).toBe(1);
  });
});

describe('rpmLimiterOptions (requests-per-minute -> bucket parameter mapping)', () => {
  it('capacity = requestsPerMinute, refillPerSecond = requestsPerMinute / 60', () => {
    expect(rpmLimiterOptions(120)).toStrictEqual({ capacity: 120, refillPerSecond: 2 });
  });

  it('handles requestsPerMinute = 1', () => {
    expect(rpmLimiterOptions(1)).toStrictEqual({
      capacity: 1,
      refillPerSecond: 1 / 60,
    });
  });

  it('handles requestsPerMinute = 60', () => {
    expect(rpmLimiterOptions(60)).toStrictEqual({ capacity: 60, refillPerSecond: 1 });
  });

  it('handles requestsPerMinute = 90', () => {
    expect(rpmLimiterOptions(90)).toStrictEqual({
      capacity: 90,
      refillPerSecond: 1.5,
    });
  });
});
