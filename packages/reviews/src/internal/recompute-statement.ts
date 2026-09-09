import { REVIEW_MODERATION_STATE } from '@repo/entities';
import { rowAs } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import { productRatingRowSchema } from './rows.js';

/**
 * The shape {@link applyRatingRecompute} returns — declared HERE, not in `../rating.js`, and
 * re-exported from there as `ProductRatingRecord`: the other direction (this file importing the
 * type from `rating.ts`, which imports `applyRatingRecompute` from this file) would be a circular
 * import between the two modules, which `no-circular` (`.dependency-cruiser.cjs`) forbids
 * workspace-wide regardless of the import being type-only.
 */
export interface ProductRatingRow {
  readonly reviewCount: number;
  readonly ratingAverage: string | null;
  readonly computedAt: Date;
}

/**
 * SPEC-0004's rating-recompute upsert, held verbatim, in exactly ONE place. Runs through
 * `executor` — the pooled `db` for a single ad hoc recompute, or an open transaction for TASK-0005's
 * relay applying one outbox row, or one iteration of `rebuildProductRating`'s batch loop. A
 * RECOMPUTE, never a delta (ADR-0014): idempotent by construction, which is what makes at-least-once
 * outbox redelivery safe. Only `published` reviews count — compared against
 * `REVIEW_MODERATION_STATE.Published.id`, never the literal `1` — so a rejected review's rating and
 * count vanish from the aggregate the same cycle as its removal from the review list (ADR-0018).
 *
 * Two callers only: `recomputeProductRating` (a thin public delegation) and `rebuildProductRating`.
 */
export async function applyRatingRecompute(
  executor: Kysely<unknown>,
  productId: string,
): Promise<ProductRatingRow> {
  const result = await sql`
    INSERT INTO reviews.product_rating (product_id, review_count, rating_average, computed_at)
    SELECT ${productId}, count(*),
           CASE WHEN count(*) = 0 THEN NULL ELSE round(avg(rating), 2) END, now()
      FROM reviews.review
     WHERE product_id = ${productId}
       AND review_moderation_state_id = ${REVIEW_MODERATION_STATE.Published.id}
    ON CONFLICT (product_id) DO UPDATE
       SET review_count   = excluded.review_count,
           rating_average = excluded.rating_average,
           computed_at    = excluded.computed_at
    RETURNING review_count, rating_average, computed_at
  `.execute(executor);
  const row = rowAs(productRatingRowSchema, result.rows[0]);
  return {
    reviewCount: row.review_count,
    ratingAverage: row.rating_average,
    computedAt: row.computed_at,
  };
}
