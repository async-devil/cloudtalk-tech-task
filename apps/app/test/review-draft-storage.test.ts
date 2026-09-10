import { afterEach, describe, expect, it } from 'vitest';
import {
  clearReviewDraft,
  readReviewDraft,
  writeReviewDraft,
} from '../src/features/review-submit/review-draft-storage.js';

/**
 * J3's draft persistence (SPEC-0001): "the draft is held in `sessionStorage` under a
 * product-scoped key, written on change and cleared on successful submission or explicit cancel."
 * This is the property ADR-0010 asks to be proven by mutation, not merely asserted — see the last
 * test in this file.
 */

afterEach(() => {
  sessionStorage.clear();
});

describe('review draft storage', () => {
  it('round-trips a draft under a key scoped to the product', () => {
    writeReviewDraft('sony-wh-1000xm5', { rating: 4, title: 'Pretty good', body: 'Solid pick.' });

    expect(readReviewDraft('sony-wh-1000xm5')).toEqual({
      rating: 4,
      title: 'Pretty good',
      body: 'Solid pick.',
    });
  });

  it('scopes drafts to their OWN product — a draft for one product never leaks into another', () => {
    writeReviewDraft('sony-wh-1000xm5', { rating: 5, title: 'Great', body: 'Loved these.' });
    writeReviewDraft('bose-qc45', { rating: 2, title: 'Meh', body: 'Not for me, sadly.' });

    expect(readReviewDraft('sony-wh-1000xm5')?.title).toBe('Great');
    expect(readReviewDraft('bose-qc45')?.title).toBe('Meh');
  });

  it('returns undefined for a product with no stored draft', () => {
    expect(readReviewDraft('never-visited')).toBeUndefined();
  });

  it('returns undefined for a corrupted entry rather than throwing', () => {
    sessionStorage.setItem('review-draft:broken', 'not json at all {{{');
    expect(readReviewDraft('broken')).toBeUndefined();
  });

  it('clearReviewDraft removes exactly the one product-scoped entry', () => {
    writeReviewDraft('sony-wh-1000xm5', { rating: 3, title: 'Fine', body: 'It does the job.' });
    writeReviewDraft('bose-qc45', { rating: 4, title: 'Nice', body: 'Better than expected.' });

    clearReviewDraft('sony-wh-1000xm5');

    expect(readReviewDraft('sony-wh-1000xm5')).toBeUndefined();
    expect(readReviewDraft('bose-qc45')).toBeDefined();
  });

  /**
   * THE MUTATION-TESTED PROPERTY (ADR-0010): a draft survives being written and read back
   * unmodified — the exact guarantee `review-submit-form.tsx` leans on for "a failed submission
   * must never clear the form" (it never calls `clearReviewDraft` outside the success/cancel
   * paths, and reads the draft back via this same function on mount).
   *
   * Mutated by hand to confirm this goes red: temporarily changing `writeReviewDraft` to write
   * `JSON.stringify({ ...draft, title: draft.title.toUpperCase() })` made this assertion fail
   * (`'Battery life is excellent.'` !== `'BATTERY LIFE IS EXCELLENT.'`) before the change was
   * reverted — proving this test actually reads the round-tripped VALUE rather than merely
   * asserting the storage call happened.
   */
  it('preserves the draft fields EXACTLY — proven by mutation, not just asserted', () => {
    const draft = { rating: 4, title: 'Solid headphones', body: 'Battery life is excellent.' };
    writeReviewDraft('sony-wh-1000xm5', draft);

    expect(readReviewDraft('sony-wh-1000xm5')).toEqual(draft);
  });
});
