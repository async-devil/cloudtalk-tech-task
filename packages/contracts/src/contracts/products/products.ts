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

/**
 * `products.create`'s input (SPEC-0003, SPEC-0001 screen S7): every field a product is created
 * whole with, `slug` the one exception — omitted, it is derived server-side from `name`; supplied,
 * it is used verbatim after this schema validates its shape (TASK-0008's own words: "derivation
 * happens server-side even though the form previews it; a client-side slug is a suggestion, never
 * the value").
 */
const productsCreateInputSchema = z.object({
  /** Mirrors `ck_product__name_not_empty`. */
  name: z.string().min(1),
  description: z.string().min(1),
  /** Validated against the closed `PRODUCT_CATEGORY` vocabulary by the pipeline
   * (`productCategoryIdFor`), which throws `VALIDATION({ field: 'categoryName' })` for an
   * unrecognised name — no stronger bound is invented here than `productSummarySchema.categoryName`
   * already carries. */
  categoryName: z.string(),
  priceMinor: z.number().int().nonnegative(),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  sku: skuSchema,
  slug: productSlugSchema.optional(),
});

/**
 * `products.update`'s input (SPEC-0003): every mutable field optional, `.refine`d to require at
 * least one (the same "at least one field present" shape `reviewUpdateInputSchema` establishes),
 * over a `.strict()` base — **`slug` and `sku` are deliberately absent from this object entirely**,
 * so a request carrying either fails Zod's own unrecognised-key rejection (`VALIDATION`) at the wire
 * boundary, before any handler code runs, rather than reaching the pipeline to be silently dropped
 * or requiring a runtime `'slug' in input` check here to catch what the type already forbids. The
 * pipeline's own guard (`productUpdateBindsFor`) still exists and is still tested — this is the
 * second, wire-level half of the same rule (SPEC-0002's immutability note: "worth exactly as much
 * as the test that proves it").
 */
const productsUpdateInputSchema = z
  .object({
    productSlug: productSlugSchema,
    name: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    categoryName: z.string().optional(),
    priceMinor: z.number().int().nonnegative().optional(),
    currencyCode: z
      .string()
      .regex(/^[A-Z]{3}$/)
      .optional(),
  })
  .strict()
  .refine(
    (input) =>
      input.name !== undefined ||
      input.description !== undefined ||
      input.categoryName !== undefined ||
      input.priceMinor !== undefined ||
      input.currencyCode !== undefined,
    {
      message:
        'At least one of name, description, categoryName, priceMinor or currencyCode must be provided.',
    },
  );

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

  /**
   * Requires the `catalogue_manager` capability (ADR-0018, SPEC-0003) — strictly stronger than the
   * plain "session required" `reviews.submit` etc. mark above: no session is `UNAUTHORIZED` (401),
   * exactly like those routes, but a resolved session whose user does not hold the capability is
   * `FORBIDDEN` (403) rather than being let through. TASK-0008's own acceptance criterion: both are
   * asserted at the HTTP layer, never against the guard in isolation.
   */
  create: oc
    .route({ method: 'POST', path: '/products' })
    .input(productsCreateInputSchema)
    .output(productDetailSchema)
    .errors({
      VALIDATION: {
        status: 400,
        message: 'The request was invalid.',
        data: apiErrorShape,
      },
      UNAUTHORIZED: {
        status: 401,
        message: 'A resolved session is required.',
        data: apiErrorShape,
      },
      FORBIDDEN: {
        status: 403,
        message: 'This session does not hold the catalogue_manager capability.',
        data: apiErrorShape,
      },
      /** A colliding slug or sku, caught from the unique constraint's typed translation — never a
       * pre-flight read that could race (SPEC-0003). `details.field` names which one. */
      CONFLICT: {
        status: 409,
        message: 'A product with this slug or sku already exists.',
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

  /**
   * Requires the `catalogue_manager` capability, same shape as `create` above. No `CONFLICT` here:
   * unlike `create`, this route never touches `slug`/`sku` — SPEC-0003's own words, "slug and sku
   * are not editable" — so the columns whose unique constraints could collide are never part of
   * this statement's `SET` list, and sending either field at all is rejected by the wire schema
   * itself as `VALIDATION`, before this route's pipeline runs.
   */
  update: oc
    .route({ method: 'PATCH', path: '/products/{productSlug}' })
    .input(productsUpdateInputSchema)
    .output(productDetailSchema)
    .errors({
      VALIDATION: {
        status: 400,
        message: 'The request was invalid.',
        data: apiErrorShape,
      },
      UNAUTHORIZED: {
        status: 401,
        message: 'A resolved session is required.',
        data: apiErrorShape,
      },
      FORBIDDEN: {
        status: 403,
        message: 'This session does not hold the catalogue_manager capability.',
        data: apiErrorShape,
      },
      NOT_FOUND: {
        status: 404,
        message: 'No product exists at this slug.',
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
