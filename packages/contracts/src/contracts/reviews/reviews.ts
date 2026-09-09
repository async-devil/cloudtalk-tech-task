import { oc } from '@orpc/contract';
import { z } from 'zod';
import { apiErrorShape } from '../error-shape.js';
import { productSlugSchema } from '../products/products.js';
import { pageOf } from '../shared/page.js';

/**
 * A review's public address (ADR-0016) — minted centrally in `@repo/entities`, never the internal
 * `review_id` uuid. Mirrors `reviews.review`'s `ck_review__token_format` (SPEC-0002).
 */
export const reviewTokenSchema = z.string().regex(/^rev_[0-9A-Za-z]{21}$/);

/** An integer star rating: no half-stars, no unrated review (SPEC-0001 rule 1). Mirrors
 * `ck_review__rating_range`. */
export const ratingSchema = z.number().int().min(1).max(5);

/** Mirrors `ck_review__title_length`. */
export const reviewTitleSchema = z.string().trim().min(3).max(120);

/** Mirrors `ck_review__body_length`. */
export const reviewBodySchema = z.string().trim().min(10).max(4000);

/**
 * One review as it appears in a product's review list, or as the result of writing one
 * (SPEC-0001 S3, S4). Every route on this namespace serves it from `reviews.review`, the
 * AUTHORITATIVE table — never the rating projection (ADR-0014) — which is why a submission is
 * visible to its own author immediately, before any recomputation has run.
 */
export const reviewSummarySchema = z.object({
  token: reviewTokenSchema,
  rating: ratingSchema,
  title: reviewTitleSchema,
  body: reviewBodySchema,
  /**
   * A stable, non-identifying label for the review's author — the local part of their sign-in
   * email, truncated, and NEVER the email itself (SPEC-0001 open question 1, resolved). See that
   * open question for the exact derivation and its fallback for an email with no local part worth
   * showing; this field only carries the router's already-derived output.
   */
  authorLabel: z.string(),
  /** Computed per request against the CALLER's own session, never cached on the row: `true` only
   * when a session is resolved and it owns this review, `false` on every row an anonymous caller
   * sees. Drives the own-review block and the Edit/Delete affordances (SPEC-0001 S3). */
  authoredByViewer: z.boolean(),
  createdAt: z.iso.datetime(),
  /** Differs from `createdAt` if and only if the review has been edited (SPEC-0001 rule 6) — the
   * "edited" marker reads this comparison directly, never a separate flag. */
  updatedAt: z.iso.datetime(),
});
export type ReviewSummary = z.infer<typeof reviewSummarySchema>;

const reviewsListForProductInputSchema = z.object({
  productSlug: productSlugSchema,
  /** Opaque keyset cursor on `(created_at, review_id)`, newest first (TASK-0003) — never a page
   * number. A cursor minted for a different sort or a different product is rejected as
   * `VALIDATION` by the router, not silently honoured (SPEC-0003). */
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const reviewSubmitInputSchema = z.object({
  productSlug: productSlugSchema,
  rating: ratingSchema,
  title: reviewTitleSchema,
  body: reviewBodySchema,
});

/** `.refine` — not three independent `.optional()` fields left to the router to cross-check —
 * because "at least one field present" is itself part of the wire contract (SPEC-0003): a PATCH
 * with none of `rating`/`title`/`body` fails validation here, automatically, the same boundary
 * every other shape violation fails at (ADR-0004). */
const reviewUpdateInputSchema = z
  .object({
    reviewToken: reviewTokenSchema,
    rating: ratingSchema.optional(),
    title: reviewTitleSchema.optional(),
    body: reviewBodySchema.optional(),
  })
  .refine(
    (input) => input.rating !== undefined || input.title !== undefined || input.body !== undefined,
    { message: 'At least one of rating, title or body must be provided.' },
  );

const reviewRemoveInputSchema = z.object({
  reviewToken: reviewTokenSchema,
});

/**
 * A product's reviews: one anonymous read and the three writes a signed-in reviewer owns
 * (SPEC-0003). `listForProduct` reads `reviews.review` directly — the authoritative table, not the
 * rating projection `products.list`/`products.get` read (ADR-0014) — which is the split TASK-0003
 * asks to keep visible in the router without a comment explaining it: this namespace boundary IS
 * that comment.
 */
export const reviewsContract = oc.router({
  listForProduct: oc
    .route({ method: 'GET', path: '/products/{productSlug}/reviews' })
    .input(reviewsListForProductInputSchema)
    .output(pageOf(reviewSummarySchema))
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

  /** Session required: an anonymous request is answered `401` before it reaches the pipeline
   * (SPEC-0003, TASK-0003) — the session dependency here mirrors `session.bootstrap`'s. */
  submit: oc
    .route({ method: 'POST', path: '/products/{productSlug}/reviews' })
    .input(reviewSubmitInputSchema)
    .output(reviewSummarySchema)
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
      NOT_FOUND: {
        status: 404,
        message: 'No product exists at this slug.',
        data: apiErrorShape,
      },
      /** The one-review-per-author constraint's typed translation (SPEC-0002) — never a raw driver
       * error. */
      CONFLICT: {
        status: 409,
        message: 'This session has already reviewed this product.',
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

  /** Session required, same as `submit`. Identity and `createdAt` are preserved; `updatedAt` moves
   * — what the "edited" marker reads (SPEC-0001). */
  update: oc
    .route({ method: 'PATCH', path: '/reviews/{reviewToken}' })
    .input(reviewUpdateInputSchema)
    .output(reviewSummarySchema)
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
      /** Another author's review, AND a review that does not exist, both answer `FORBIDDEN` —
       * deliberately the same code, so this endpoint is never an existence oracle (SPEC-0001 rule
       * 5, SPEC-0003). There is no `NOT_FOUND` on this route. */
      FORBIDDEN: {
        status: 403,
        message: 'This session does not own that review.',
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

  /** Session required, same ownership rule as `update` (SPEC-0003) — and, deliberately, NOT a
   * member of the `review-submission` rate-limit bucket (ADR-0019): that bucket covers `submit` and
   * `update` only. */
  remove: oc
    .route({ method: 'DELETE', path: '/reviews/{reviewToken}' })
    .input(reviewRemoveInputSchema)
    .output(z.object({ token: reviewTokenSchema }))
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
        message: 'This session does not own that review.',
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
