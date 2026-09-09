import { METRIC_ATTRIBUTE } from '@repo/observability';
import { rowsAs } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import { obs } from './internal/observability.js';
import { applyRatingRecompute, type ProductRatingRow } from './internal/recompute-statement.js';
import { resolveProductId } from './internal/resolve-product.js';
import { productIdRowSchema } from './internal/rows.js';

/** `reviews.product_rating`'s public shape — an alias of `internal/recompute-statement.ts`'s
 * `ProductRatingRow` (declared there, not here, to avoid a circular import between this file and
 * the one `applyRatingRecompute` lives in). `ratingAverage` stays `string | null` all the way out
 * — see `internal/rows.ts`'s `productRatingRowSchema` doc and this module's README for why. */
export type ProductRatingRecord = ProductRatingRow;

/** `recomputeProductRating`'s outcome vocabulary, as a const-object value set (ADR-0003) — the
 * `outcome` value recorded on both `RATING_RECOMPUTE_INSTRUMENT` and `RATING_LAG_INSTRUMENT`. */
export const RATING_RECOMPUTE_OUTCOME = {
  Success: 'success',
  Error: 'error',
} as const;
export type RatingRecomputeOutcome =
  (typeof RATING_RECOMPUTE_OUTCOME)[keyof typeof RATING_RECOMPUTE_OUTCOME];

/** `reviews.rating.recompute`: counter incremented once per `recomputeProductRating` call —
 * exported (SPEC-0004, TASK-0005) so a test can assert its name/attributes without restating them,
 * the same shape `packages/jobs/src/outbox.ts` exports `OUTBOX_RUN_INSTRUMENT` etc. */
export const RATING_RECOMPUTE_INSTRUMENT = {
  name: 'reviews.rating.recompute',
  allowedAttributes: [METRIC_ATTRIBUTE.Outcome],
} as const;
const ratingRecomputeCounter = obs.createCounter(RATING_RECOMPUTE_INSTRUMENT);

/** `reviews.rating.lag`: histogram of ms from the outbox row's `created_at` to the moment its
 * recomputation commits (SPEC-0004) — recorded only when the caller supplies
 * `outboxRowCreatedAt` (see {@link RecomputeProductRatingOptions}), since a rebuild has no outbox
 * row and therefore no lag to honestly report. */
export const RATING_LAG_INSTRUMENT = {
  name: 'reviews.rating.lag',
  unit: 'ms',
  allowedAttributes: [METRIC_ATTRIBUTE.Outcome],
} as const;
const ratingLagHistogram = obs.createHistogram(RATING_LAG_INSTRUMENT);

export interface RecomputeProductRatingOptions {
  /**
   * The delivering outbox row's `created_at` — needed to compute `reviews.rating.lag` (SPEC-0004:
   * ms from the outbox row's creation to the moment THIS recomputation commits). An options
   * object rather than a bare third positional `Date`, for two reasons: it keeps both existing
   * two-argument call sites (this module's own ad hoc callers, and `rebuildProductRating` below)
   * compiling unchanged, and it makes the omission self-documenting at the call site
   * (`recomputeProductRating(db, id)` reads as "no outbox row", not as a forgotten argument).
   * Optional: `rebuildProductRating` recomputes with no outbox row in hand at all, and fabricating
   * a lag value (e.g. 0) for it would misreport staleness rather than honestly recording none.
   */
  readonly outboxRowCreatedAt?: Date;
}

/**
 * A thin public delegation to `applyRatingRecompute` for the actual SQL — SPEC-0004's recompute
 * statement still lives in exactly one place (`internal/recompute-statement.ts`) — wrapped in this
 * module's `reviews.rating.recompute` span/counter/histogram (ADR-0009, SPEC-0004, TASK-0005). The
 * outbox relay's `apply` wires straight to this function (the composition root, `apps/api/src/
 * runtime/`), passing the claimed row's `createdAt`; `rebuildProductRating` calls it too, with no
 * `options` at all, so a rebuild still gets the span/counter but never a lag value.
 */
export function recomputeProductRating(
  db: Kysely<unknown>,
  productId: string,
  options: RecomputeProductRatingOptions = {},
): Promise<ProductRatingRecord> {
  return obs.withSpan('reviews.rating.recompute', async (span) => {
    // Ids belong on spans, never on metric attributes (ADR-0009 cardinality budget) — this is the
    // one place `productId` is worth attaching, since every other signal below is an aggregate.
    span.setAttribute('productId', productId);
    try {
      const result = await applyRatingRecompute(db, productId);
      ratingRecomputeCounter.add(1, { outcome: RATING_RECOMPUTE_OUTCOME.Success });
      if (options.outboxRowCreatedAt !== undefined) {
        const lagMs = Math.max(
          0,
          result.computedAt.getTime() - options.outboxRowCreatedAt.getTime(),
        );
        ratingLagHistogram.record(lagMs, { outcome: RATING_RECOMPUTE_OUTCOME.Success });
      }
      return result;
    } catch (error) {
      // NOT catch-log-rethrow (ADR-0008): no log call here, and the error propagates unchanged.
      // The boundary that HANDLES this failure — decides retry vs. park, logs once — is
      // `relayOutboxBatch` (`@repo/jobs`), not this function. Recording the outcome counter on the
      // way through is telemetry, not handling: it never swallows, translates, or delays the
      // throw, so it does not double the boundary's own `warn` log on eventual parking.
      ratingRecomputeCounter.add(1, { outcome: RATING_RECOMPUTE_OUTCOME.Error });
      throw error;
    }
  });
}

export interface RebuildProductRatingOptions {
  /** Recomputes exactly one product instead of the whole table. */
  readonly productSlug?: string;
  /** Keyset page size for the unscoped rebuild. @default 500 */
  readonly batchSize?: number;
}

export interface RebuildProductRatingReport {
  readonly productsRecomputed: number;
}

const DEFAULT_REBUILD_BATCH_SIZE = 500;

/**
 * Drives the unscoped rebuild from `SELECT DISTINCT product_id FROM reviews.review`, never from
 * `reviews.product` — this module's ruling (ADR-0014). A product with no reviews carries no
 * `reviews.product_rating` row in steady state (SPEC-0002: every read joins it `LEFT`); scanning
 * `reviews.product` instead would insert a `(0, NULL)` row for every never-reviewed product — a row
 * the event path never creates, and one that would make an unrated product display a `computedAt`
 * for a computation that answers nothing. Keyset-paged by `product_id` in `batchSize` chunks.
 *
 * NAMED EDGE, stated rather than silently absorbed: a product whose LAST review was deleted keeps
 * its now-stale `(0, NULL)` row in steady state (nothing ever recomputes a product with zero
 * reviews again), and a full rebuild does not recreate or touch it either — this scan only ever
 * visits ids `reviews.review` still names, so a product no longer in that `DISTINCT` set is left
 * exactly as rebuild found it.
 *
 * Scoped mode (`productSlug` given) recomputes exactly one product and returns without paging.
 * Emits no outbox rows either way: a rebuild IS the application, never a request for one
 * (SPEC-0004).
 */
export function rebuildProductRating(
  db: Kysely<unknown>,
  options: RebuildProductRatingOptions = {},
): Promise<RebuildProductRatingReport> {
  return obs.withSpan('reviews.rating.rebuild', async () => {
    if (options.productSlug !== undefined) {
      const productId = await resolveProductId(db, options.productSlug);
      // Through `recomputeProductRating`, not `applyRatingRecompute` directly, so a rebuild's
      // recomputations carry the same span/counter as every other one — with no
      // `outboxRowCreatedAt` (there is no outbox row here), so no lag is recorded (SPEC-0004).
      await recomputeProductRating(db, productId);
      return { productsRecomputed: 1 };
    }

    const batchSize = options.batchSize ?? DEFAULT_REBUILD_BATCH_SIZE;
    let cursor: string | undefined;
    let productsRecomputed = 0;

    for (;;) {
      const result =
        cursor === undefined
          ? await sql`
              SELECT DISTINCT product_id FROM reviews.review
              ORDER BY product_id
              LIMIT ${batchSize}
            `.execute(db)
          : await sql`
              SELECT DISTINCT product_id FROM reviews.review
              WHERE product_id > ${cursor}
              ORDER BY product_id
              LIMIT ${batchSize}
            `.execute(db);

      const page = rowsAs(productIdRowSchema, result.rows);
      if (page.length === 0) {
        break;
      }
      for (const row of page) {
        await recomputeProductRating(db, row.product_id);
        productsRecomputed += 1;
      }
      cursor = page[page.length - 1]?.product_id;
      if (page.length < batchSize) {
        break;
      }
    }

    return { productsRecomputed };
  });
}
