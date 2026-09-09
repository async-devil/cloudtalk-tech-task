import { z } from 'zod';

// Static schemas only (ADR-0004: raw SQL rows are a parse boundary, parsed through `rowAs`/
// `rowsAs` from `@repo/persistence`). One kind of declaration: every export below is a row schema
// for a `reviews`/`reference` table this module reads.

/**
 * `{ product_id }` — the shape of any row whose only column is `product_id`. Two call sites share
 * it: `internal/resolve-product.ts`'s slug -> id lookup against `reviews.product`, and
 * `rebuildProductRating`'s `SELECT DISTINCT product_id FROM reviews.review` page scan. Never
 * exported past this module (ADR-0016: no internal uuid crosses this module's public contract).
 */
export const productIdRowSchema = z.object({ product_id: z.string() });

/**
 * `reviews.product`'s row shape as read back off an `INSERT`/`UPDATE ... RETURNING`. No
 * `product_id` column here on purpose — no exported record type carries an internal uuid
 * (ADR-0016); a write path that separately needs the id reads it through
 * {@link productIdRowSchema} instead. `product_category_id`/`price_minor` are integers;
 * `created_at`/`updated_at` are `timestamptz` -> `z.date()` — a silent `InternalError` via
 * `rowAs` the moment this ever disagrees with the migration's column types.
 */
export const productRowSchema = z.object({
  slug: z.string(),
  sku: z.string(),
  name: z.string(),
  description: z.string(),
  product_category_id: z.number().int(),
  price_minor: z.number().int(),
  currency_code: z.string(),
  created_at: z.date(),
  updated_at: z.date(),
});

/**
 * `reviews.review`'s row shape as read back off an `INSERT ... RETURNING` or a plain `SELECT`. No
 * `review_id`/`product_id`/`author_id`: the same "no internal uuid" rule, and neither id is ever
 * needed once the row is in hand — `product_id` is always already known by the caller (it is what
 * the query filtered on) and `author_id` never needs to leave this module at all.
 */
export const reviewRowSchema = z.object({
  token: z.string(),
  rating: z.number().int(),
  title: z.string(),
  body: z.string(),
  review_moderation_state_id: z.number().int(),
  created_at: z.date(),
  updated_at: z.date(),
});

/**
 * `reviews.product_rating`'s row shape. `rating_average` is `numeric(3,2)`, and the Postgres
 * driver returns a `numeric` column as a STRING, never a number — parsed here as `string | null`
 * and carried that way all the way out to `ProductRatingRecord`. Converting it to a number in this
 * package would reintroduce the rounding argument `numeric` exists to end, and TASK-0002's
 * idempotence and drop-and-rebuild proofs depend on comparing this value EXACTLY; TASK-0003 is
 * where a number is ever produced, at the wire. See the module README's note on this.
 */
export const productRatingRowSchema = z.object({
  review_count: z.number().int(),
  rating_average: z.string().nullable(),
  computed_at: z.date(),
});
