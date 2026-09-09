import { describe, expect, it } from 'vitest';
import { fullJitterBackoff } from '../src/index.js';

describe('fullJitterBackoff', () => {
  const options = { baseMs: 1000, capMs: 60_000 };

  it('attempt = 0 returns value in range [0, baseMs]', () => {
    for (let sample = 0; sample < 50; sample += 1) {
      const value = fullJitterBackoff(0, options);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(options.baseMs);
    }
  });

  it('stays within `0 <= v <= min(cap, base*2**attempt)` (named invariant)', () => {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const expectedCap = Math.min(options.capMs, options.baseMs * 2 ** attempt);
      for (let sample = 0; sample < 50; sample += 1) {
        const value = fullJitterBackoff(attempt, options);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(expectedCap);
      }
    }
  });

  it('caps at `capMs` once the exponential term exceeds it', () => {
    const value = fullJitterBackoff(20, options);
    expect(value).toBeLessThanOrEqual(options.capMs);
  });
});
