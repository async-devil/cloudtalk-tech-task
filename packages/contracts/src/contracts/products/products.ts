import { oc } from '@orpc/contract';
import { z } from 'zod';
import { apiErrorShape } from '../error-shape.js';
import { pageOf } from '../shared/page.js';

/**
 * A catalogue product's public address (ADR-0016): lowercase, hyphen-separated, minted from the
 * product's name at creation and immutable afterward — a rename changes the name, never the
 * address. Mirrors `reviews.product`'s `ck_product__slug_format` / `ck_product__slug_length`
 * (SPEC-0002): two layers for one rule, deliberately, since the schema is the message a caller
 * reads when they hand-build a URL and the `CHECK` is what holds when a write skips this schema.
 */
export const productSlugSchema = z
  .string()
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  .min(3)
  .max(80);

/**
 * The business identifier a warehouse already uses (ADR-0016) — data on the row, never a path
 * segment. Mirrors `ck_product__sku_format`.
 */
export const skuSchema = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/);

/**
 * A product's derived, rebuildable rating (ADR-0014). Two nullability rules a UI has to get right,
 * because getting either wrong renders a lie:
 *
 * - **`ratingAverage` is `null` exactly when `reviewCount` is `0`** — never `0` or `0.0` for an
 *   unrated product; SPEC-0001 rule 14 renders that case as "No reviews yet". This mirrors
 *   `reviews.product_rating`'s `ck_product_rating__average_present_when_reviewed` constraint
 *   (SPEC-0002), which makes "no reviews" and "no average" one fact rather than two that could
 *   disagree.
 * - **`computedAt` is `null` until the first recomputation ever runs** for this product. A product
 *   with zero reviews has no projection row at all (SPEC-0002), so this is never backfilled with
 *   `created_at` or the current time — either would claim a computation that never happened.
 *
 * **A wire/storage mismatch the ROUTER must bridge, not this schema:** `@repo/reviews` returns
 * `ratingAverage` as a `string` — Postgres hands a `numeric(3,2)` column back as text, and the
 * module keeps that precision exact on purpose. `z.number()` below is the WIRE type; converting the
 * module's `string` (and its `null`) into this shape is the router implementation's job.
 */
export const ratingAggregateSchema = z.object({
  reviewCount: z.number().int().nonnegative(),
  ratingAverage: z.number().min(1).max(5).nullable(),
  computedAt: z.iso.datetime().nullable(),
});
export type RatingAggregate = z.infer<typeof ratingAggregateSchema>;

/**
 * The catalogue card / list-row shape (SPEC-0001 S2). `products.list` reads this from
 * `reviews.product_rating` joined to `reviews.product` — the rating PROJECTION, never the
 * authoritative review rows (ADR-0014) — which is the entire point of the projection and is why
 * `rating` sits here rather than being computed per row from `reviewSummary`.
 */
export const productSummarySchema = z.object({
  slug: productSlugSchema,
  sku: skuSchema,
  /** Mirrors `ck_product__name_not_empty`. */
  name: z.string().min(1),
  /** The joined `reference.product_category.name` label — no `CHECK` to mirror beyond `NOT NULL`
   * (SPEC-0002), so no additional bound is invented here. */
  categoryName: z.string(),
  /** Minor units, never a float (ADR-0016). Mirrors `ck_product__price_minor_non_negative`. */
  priceMinor: z.number().int().nonnegative(),
  /** Mirrors `ck_product__currency_code_iso`. */
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  rating: ratingAggregateSchema,
});
export type ProductSummary = z.infer<typeof productSummarySchema>;

/** `productSummary` plus the one field a catalogue card has no room for (SPEC-0001 S3's header). No
 * additional bound beyond `NOT NULL` is invented for `description` — SPEC-0002 has no `CHECK` on it. */
export const productDetailSchema = productSummarySchema.extend({
  description: z.string(),
});
export type ProductDetail = z.infer<typeof productDetailSchema>;

const productsListInputSchema = z.object({
  /** Case-insensitive substring match on product **name or SKU** (SPEC-0003) — pasting a SKU finds
   * its product. */
  query: z.string().max(80).optional(),
  category: z.string().optional(),
  /** `'rating'` orders by `rating_average DESC NULLS LAST` then `review_count DESC` — unrated
   * products sort last (SPEC-0001 open question 4). */
  sort: z.enum(['rating', 'recent', 'name']).default('rating'),
  cursor: z.string().optional(),
  /** `z.coerce`: a GET route's query string carries every value as text, `limit` included. The
   * ceiling is the whole enforcement — a `limit` above 50 fails validation here and is never
   * silently capped (TASK-0003): a caller who asked for 500 and got 50 with no error has been lied
   * to about the size of the result set. */
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

/**
 * The catalogue's two anonymous reads (SPEC-0003). Both read `reviews.product_rating` joined to
 * `reviews.product` — the projection (ADR-0014) — which is why every success output here carries a
 * `rating` field and no `reviewSummary` ever appears on this namespace; `reviews.listForProduct`
 * reads the authoritative table instead, and lives on the `reviews` namespace for exactly that
 * reason (TASK-0003's note).
 */
export const productsContract = oc.router({
  list: oc
    .route({ method: 'GET', path: '/products' })
    .input(productsListInputSchema)
    .output(pageOf(productSummarySchema))
    .errors({
      VALIDATION: {
        status: 400,
        message: 'The request was invalid.',
        data: apiErrorShape,
      },
      RATE_LIMITED: {
        status: 429,
        message: 'Too many requests.',
        data: apiErrorShape,
      },
      PROVIDER: {
        status: 502,
        message: 'An upstream provider failed.',
        data: apiErrorShape,
      },
      INTERNAL: {
        status: 500,
        message: 'An internal error occurred.',
        data: apiErrorShape,
      },
    }),

  get: oc
    .route({ method: 'GET', path: '/products/{productSlug}' })
    .input(z.object({ productSlug: productSlugSchema }))
    .output(productDetailSchema)
    .errors({
      VALIDATION: {
        status: 400,
        message: 'The request was invalid.',
        data: apiErrorShape,
      },
      NOT_FOUND: {
        status: 404,
        message: 'No product exists at this slug.',
        data: apiErrorShape,
      },
      RATE_LIMITED: {
        status: 429,
        message: 'Too many requests.',
        data: apiErrorShape,
      },
      PROVIDER: {
        status: 502,
        message: 'An upstream provider failed.',
        data: apiErrorShape,
      },
      INTERNAL: {
        status: 500,
        message: 'An internal error occurred.',
        data: apiErrorShape,
      },
    }),
});
