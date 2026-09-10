import { describe, expect, it } from 'vitest';
import { formatComputedAt } from '../src/shared/formatting/relative-time.js';

const NOW = new Date('2026-09-10T12:00:00.000Z');

describe('formatComputedAt', () => {
  it('renders "just now" for anything under a minute old', () => {
    expect(formatComputedAt('2026-09-10T11:59:59.000Z', NOW)).toBe('just now');
    expect(formatComputedAt(NOW.toISOString(), NOW)).toBe('just now');
  });

  it('renders whole minutes, singular at exactly one', () => {
    expect(formatComputedAt('2026-09-10T11:59:00.000Z', NOW)).toBe('1 minute ago');
    expect(formatComputedAt('2026-09-10T11:45:00.000Z', NOW)).toBe('15 minutes ago');
    expect(formatComputedAt('2026-09-10T11:01:00.000Z', NOW)).toBe('59 minutes ago');
  });

  it('renders whole hours, singular at exactly one', () => {
    expect(formatComputedAt('2026-09-10T11:00:00.000Z', NOW)).toBe('1 hour ago');
    expect(formatComputedAt('2026-09-10T08:00:00.000Z', NOW)).toBe('4 hours ago');
    expect(formatComputedAt('2026-09-09T13:00:00.000Z', NOW)).toBe('23 hours ago');
  });

  it('renders whole days, singular at exactly one', () => {
    expect(formatComputedAt('2026-09-09T12:00:00.000Z', NOW)).toBe('1 day ago');
    expect(formatComputedAt('2026-09-03T12:00:00.000Z', NOW)).toBe('7 days ago');
  });

  it('never goes negative for a computed-at that is (clock-skew) after now', () => {
    expect(formatComputedAt('2026-09-10T12:05:00.000Z', NOW)).toBe('just now');
  });

  it('defaults `now` to the real wall clock when omitted', () => {
    const justComputed = new Date().toISOString();
    expect(formatComputedAt(justComputed)).toBe('just now');
  });
});
