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

/**
 * A thin public delegation to `applyRatingRecompute` — this function writes no SQL of its own, on
 * purpose, so SPEC-0004's recompute statement lives in exactly one place
 * (`internal/recompute-statement.ts`). TASK-0005 wires the outbox relay's `apply` to this
 * function and adds its span and instruments INSIDE it; nothing here anticipates that wiring.
 */
export function recomputeProductRating(
  db: Kysely<unknown>,
  productId: string,
): Promise<ProductRatingRecord> {
  return applyRatingRecompute(db, productId);
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
      await applyRatingRecompute(db, productId);
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
        await applyRatingRecompute(db, row.product_id);
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
