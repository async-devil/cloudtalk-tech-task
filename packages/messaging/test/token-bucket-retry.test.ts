import { describe, expect, it } from 'vitest';
import { computeTokenBucketRetryAfterMs } from '../src/internal/token-bucket-retry.js';

describe('computeTokenBucketRetryAfterMs (spec §5 frozen formula)', () => {
  it('cost fits, returns 0', () => {
    expect(
      computeTokenBucketRetryAfterMs({
        cost: 5,
        refilled: 10,
        refillPerSecond: 2,
      }),
    ).toBe(0);
  });

  it('cost does not fit, returns positive value', () => {
    expect(
      computeTokenBucketRetryAfterMs({
        cost: 10,
        refilled: 2,
        refillPerSecond: 2,
      }),
    ).toBe(4000);
  });

  it('handles fractional refillPerSecond', () => {
    expect(
      computeTokenBucketRetryAfterMs({
        cost: 2,
        refilled: 0.5,
        refillPerSecond: 0.5,
      }),
    ).toBe(3000);
  });

  it('ceil rounds up boundary case', () => {
    expect(
      computeTokenBucketRetryAfterMs({
        cost: 3,
        refilled: 1,
        refillPerSecond: 2,
      }),
    ).toBe(1000);
  });
});
