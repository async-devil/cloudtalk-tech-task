import { describe, expect, it } from 'vitest';
import {
  productCategoryIdFor,
  productCategoryNameFor,
  reviewModerationStateNameFor,
} from '../src/internal/reference-ids.js';

/**
 * Pins `internal/reference-ids.ts` against SPEC-0002's literal seeded ids — deliberately NOT
 * against `PRODUCT_CATEGORY`/`REVIEW_MODERATION_STATE` themselves. Reading the expected value back
 * off the same const the lookup is built from would make this test agree with the implementation
 * by construction, and it would stay green through a renumbering that broke the seeded-row
 * contract — exactly the "fixture shaped to agree with the implementation it tests" ADR-0010
 * warns against. These numbers ARE the contract (SPEC-0002: "Ids are the contract and are never
 * renumbered"), so they are written here as literals, on purpose.
 */
describe('reference-ids: pinned against SPEC-0002 seeded ids', () => {
  it('resolves every product category name to its seeded id', () => {
    expect(productCategoryIdFor('audio')).toBe(1);
    expect(productCategoryIdFor('computing')).toBe(2);
    expect(productCategoryIdFor('home')).toBe(3);
    expect(productCategoryIdFor('outdoor')).toBe(4);
    expect(productCategoryIdFor('kitchen')).toBe(5);
  });

  it('resolves a category name regardless of case or surrounding whitespace', () => {
    // The only free-text input this closed vocabulary is ever matched against — the
    // catalogue-authoring form and the catalogue's own search filter — has no vocabulary hint
    // beyond the filter's own placeholder text, which is itself capitalized ("e.g. Audio").
    expect(productCategoryIdFor('Audio')).toBe(1);
    expect(productCategoryIdFor('AUDIO')).toBe(1);
    expect(productCategoryIdFor('  audio  ')).toBe(1);
  });

  it('still rejects a name that names no seeded category, normalized or not', () => {
    expect(() => productCategoryIdFor('Not A Real Category')).toThrow(
      'unknown product category "Not A Real Category"',
    );
  });

  it('resolves every seeded product category id back to its name', () => {
    expect(productCategoryNameFor(1)).toBe('audio');
    expect(productCategoryNameFor(2)).toBe('computing');
    expect(productCategoryNameFor(3)).toBe('home');
    expect(productCategoryNameFor(4)).toBe('outdoor');
    expect(productCategoryNameFor(5)).toBe('kitchen');
  });

  it('resolves every seeded review moderation state id to its name', () => {
    expect(reviewModerationStateNameFor(1)).toBe('published');
    expect(reviewModerationStateNameFor(2)).toBe('pending');
    expect(reviewModerationStateNameFor(3)).toBe('rejected');
  });
});
