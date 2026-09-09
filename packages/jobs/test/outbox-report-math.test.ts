import { describe, expect, it } from 'vitest';
import { computeOldestPendingAgeMs } from '../src/outbox.js';

describe('computeOldestPendingAgeMs (backlog histogram input, "report math")', () => {
  it('computes the millisecond age between the oldest row and now', () => {
    const oldest = new Date('2026-07-16T00:00:00.000Z');
    const now = new Date('2026-07-16T00:00:05.500Z');
    expect(computeOldestPendingAgeMs(oldest, now)).toBe(5_500);
  });

  it('never returns a negative age (clock skew floor)', () => {
    const oldest = new Date('2026-07-16T00:00:05.000Z');
    const now = new Date('2026-07-16T00:00:00.000Z');
    expect(computeOldestPendingAgeMs(oldest, now)).toBe(0);
  });

  it('returns 0 for the same instant', () => {
    const instant = new Date('2026-07-16T00:00:00.000Z');
    expect(computeOldestPendingAgeMs(instant, instant)).toBe(0);
  });
});
