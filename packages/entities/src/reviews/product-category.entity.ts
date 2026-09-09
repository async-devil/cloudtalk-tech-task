import { z } from 'zod';

/**
 * The catalogue's product-category vocabulary (ADR-0006, ADR-0016) — the single source
 * `reference.product_category` is seeded from
 * (`packages/persistence/migrations/0004-create-reviews.ts`) and
 * `packages/reviews/test-integration/reference-parity.test.ts` pins. See {@link STAGE_STATUS}
 * (`jobs/stage-status.entity.ts`) for why the `{ id, name }` record shape is frozen: it mirrors the
 * reference table's two columns exactly, so a parity test never needs a transformation between this
 * const object and `SELECT * FROM reference.product_category` — a transformation is where drift
 * hides. Ids are the contract — they appear in `reviews.product.product_category_id` — and are
 * never renumbered.
 */
export const PRODUCT_CATEGORY = {
  Audio: { id: 1, name: 'audio' },
  Computing: { id: 2, name: 'computing' },
  Home: { id: 3, name: 'home' },
  Outdoor: { id: 4, name: 'outdoor' },
  Kitchen: { id: 5, name: 'kitchen' },
} as const;
export type ProductCategoryId = (typeof PRODUCT_CATEGORY)[keyof typeof PRODUCT_CATEGORY]['id'];
export type ProductCategoryName = (typeof PRODUCT_CATEGORY)[keyof typeof PRODUCT_CATEGORY]['name'];

/** The `reference.product_category` row shape (ADR-0004 raw-SQL parse boundary) — used by the
 * parity proof and by any code reading the vocabulary back from Postgres. */
export const productCategoryRowSchema = z.object({
  product_category_id: z.number().int(),
  name: z.string(),
});
export type ProductCategoryRow = z.infer<typeof productCategoryRowSchema>;
