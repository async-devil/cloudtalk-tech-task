import { METRIC_ATTRIBUTE } from '@repo/observability';
import { describe, expect, it } from 'vitest';
import {
  RATING_LAG_INSTRUMENT,
  RATING_RECOMPUTE_INSTRUMENT,
  RATING_RECOMPUTE_OUTCOME,
} from '../src/index.js';

// The instrument specifications, asserted from the exported consts rather than restated
// (TASK-0005) — the same shape `packages/jobs/test/metrics.test.ts` uses for `OUTBOX_RUN_INSTRUMENT`
// et al. A rename of either name or a widened `allowedAttributes` set turns one of these red.
describe('reviews rating instruments (ADR-0009, SPEC-0004)', () => {
  it('reviews.rating.recompute (counter) has the right name and only the outcome attribute', () => {
    expect(RATING_RECOMPUTE_INSTRUMENT.name).toBe('reviews.rating.recompute');
    expect([...RATING_RECOMPUTE_INSTRUMENT.allowedAttributes]).toEqual([METRIC_ATTRIBUTE.Outcome]);
  });

  it('reviews.rating.lag (histogram) has the right name, unit ms, and only the outcome attribute', () => {
    expect(RATING_LAG_INSTRUMENT.name).toBe('reviews.rating.lag');
    expect(RATING_LAG_INSTRUMENT.unit).toBe('ms');
    expect([...RATING_LAG_INSTRUMENT.allowedAttributes]).toEqual([METRIC_ATTRIBUTE.Outcome]);
  });

  it('RATING_RECOMPUTE_OUTCOME is the closed success/error vocabulary both instruments record', () => {
    expect(RATING_RECOMPUTE_OUTCOME).toEqual({ Success: 'success', Error: 'error' });
  });
});
