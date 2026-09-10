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

/**
 * `reviews.review`'s ownership pair (TASK-0003) — read by token before `updateReview`/
 * `removeReview` decide `FORBIDDEN` vs proceed (SPEC-0001 rule 5). Never exported past this
 * module: `author_id` is an internal uuid, and this shape exists only to be compared against the
 * acting session's own id, never to be handed back to a caller.
 */
export const reviewOwnerRowSchema = z.object({
  product_id: z.string(),
  author_id: z.string(),
});

/**
 * `reviews.review`'s row shape for `updateReview`'s `UPDATE ... RETURNING` (TASK-0003). No
 * `review_moderation_state_id`: an edit never touches moderation state, so this is a narrower
 * sibling of {@link reviewRowSchema} rather than a reuse of it.
 */
export const reviewMutationRowSchema = z.object({
  token: z.string(),
  rating: z.number().int(),
  title: z.string(),
  body: z.string(),
  created_at: z.date(),
  updated_at: z.date(),
});

/**
 * `reviews.review`'s row shape for a product's review list (`listReviewsForProduct`, TASK-0003) —
 * read from the AUTHORITATIVE table, never the rating projection (ADR-0014). `author_id` is read
 * here and carried out on {@link ../reviews.js!ReviewListItem} as a deliberate, narrow exception
 * to "no internal uuid crosses this module's public contract" — see that type's own doc for why.
 */
export const reviewListRowSchema = z.object({
  token: z.string(),
  rating: z.number().int(),
  title: z.string(),
  body: z.string(),
  author_id: z.string(),
  created_at: z.date(),
  updated_at: z.date(),
});

/**
 * `reviews.product` LEFT JOINed to `reviews.product_rating` (ADR-0014) — the row shape
 * `listProducts`/`getProductBySlug` both read (TASK-0003). A never-reviewed product has no
 * `product_rating` row at all (SPEC-0002), so the join leaves `rating_average`/`computed_at` NULL;
 * `review_count` is `COALESCE`d to `0` in the query itself (SPEC-0002: "no reviews" and "no
 * average" are one fact), so only the other two stay nullable here. `created_at` is the product's
 * own row-creation timestamp — carried for `listProducts`' `'recent'` sort/cursor key only; it is
 * not part of any exported record.
 */
export const productSummaryRowSchema = z.object({
  slug: z.string(),
  sku: z.string(),
  name: z.string(),
  product_category_id: z.number().int(),
  price_minor: z.number().int(),
  currency_code: z.string(),
  created_at: z.date(),
  review_count: z.number().int(),
  rating_average: z.string().nullable(),
  computed_at: z.date().nullable(),
});

/** {@link productSummaryRowSchema} plus the one field a catalogue card has no room for
 * (SPEC-0001 S3's header) — `getProductBySlug`'s row shape. */
export const productDetailRowSchema = productSummaryRowSchema.extend({
  description: z.string(),
});
