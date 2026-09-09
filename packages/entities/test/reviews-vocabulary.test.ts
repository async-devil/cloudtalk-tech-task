import { describe, expect, it } from 'vitest';
import {
  PRODUCT_CATEGORY,
  productCategoryRowSchema,
  REVIEW_MODERATION_STATE,
  reviewModerationStateRowSchema,
} from '../src/index.js';

// ADR-0006: each vocabulary const object is `{ id, name }` records, never a bare `name -> id`
// map — the shape a `SELECT * FROM reference.<vocabulary>` parity test
// (packages/reviews/test-integration/reference-parity.test.ts) compares against with zero
// transformation in between.
describe('PRODUCT_CATEGORY (reviews catalogue)', () => {
  it('is a closed { id, name } record set, ids never renumbered', () => {
    expect(PRODUCT_CATEGORY).toStrictEqual({
      Audio: { id: 1, name: 'audio' },
      Computing: { id: 2, name: 'computing' },
      Home: { id: 3, name: 'home' },
      Outdoor: { id: 4, name: 'outdoor' },
      Kitchen: { id: 5, name: 'kitchen' },
    });
  });

  it('every row parses through productCategoryRowSchema (ADR-0008)', () => {
    for (const row of Object.values(PRODUCT_CATEGORY)) {
      expect(
        productCategoryRowSchema.parse({ product_category_id: row.id, name: row.name }),
      ).toStrictEqual({ product_category_id: row.id, name: row.name });
    }
  });
});

describe('REVIEW_MODERATION_STATE (reviews)', () => {
  it('is a closed { id, name } record set — Pending is seeded but written by nothing in v1', () => {
    expect(REVIEW_MODERATION_STATE).toStrictEqual({
      Published: { id: 1, name: 'published' },
      Pending: { id: 2, name: 'pending' },
      Rejected: { id: 3, name: 'rejected' },
    });
  });

  it('every row parses through reviewModerationStateRowSchema (ADR-0008)', () => {
    for (const row of Object.values(REVIEW_MODERATION_STATE)) {
      expect(
        reviewModerationStateRowSchema.parse({
          review_moderation_state_id: row.id,
          name: row.name,
        }),
      ).toStrictEqual({ review_moderation_state_id: row.id, name: row.name });
    }
  });
});
