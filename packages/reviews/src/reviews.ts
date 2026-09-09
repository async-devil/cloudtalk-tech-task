import {
  mintToken,
  REVIEW_MODERATION_STATE,
  type ReviewModerationStateName,
  TOKEN_PREFIX,
} from '@repo/entities';
import { insertOutboxRows } from '@repo/jobs';
import { ConflictError } from '@repo/kernel';
import { rowAs } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import type { z } from 'zod';
import { acquireReviewLock } from './internal/advisory-lock.js';
import { obs } from './internal/observability.js';
import { reviewModerationStateNameFor } from './internal/reference-ids.js';
import { resolveProductId } from './internal/resolve-product.js';
import { reviewRowSchema } from './internal/rows.js';
import {
  translateUniqueViolation,
  UNIQUE_CONSTRAINT,
  uniqueViolationConstraintOf,
} from './internal/unique-violation.js';
import { RATING_RECOMPUTE_OP, REVIEWS_OUTBOX } from './outbox.js';

/** `submitReview`'s input. `authorId` is `auth.app_user.app_user_id` — resolved by the caller
 * (TASK-0003's session middleware), never minted or looked up here. */
export interface SubmitReviewInput {
  readonly productSlug: string;
  readonly authorId: string;
  readonly rating: number;
  readonly title: string;
  readonly body: string;
}

/** A review's public shape. No `review_id`/`product_id`/`author_id` (ADR-0016: no internal uuid
 * crosses this module's public contract) — `token` is the only identifier that ever leaves it. */
export interface ReviewRecord {
  readonly token: string;
  readonly productSlug: string;
  readonly rating: number;
  readonly title: string;
  readonly body: string;
  readonly moderationState: ReviewModerationStateName;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SubmitReviewResult {
  readonly review: ReviewRecord;
  /** `true` when this call returned an ALREADY-committed review rather than writing a new one
   * (ADR-0007: idempotent replay by natural key) — never `true` together with a second outbox
   * row for the same submission. */
  readonly replayed: boolean;
}

type ReviewRow = z.infer<typeof reviewRowSchema>;

function toReviewRecord(productSlug: string, row: ReviewRow): ReviewRecord {
  return {
    token: row.token,
    productSlug,
    rating: row.rating,
    title: row.title,
    body: row.body,
    moderationState: reviewModerationStateNameFor(row.review_moderation_state_id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function readExistingReview(
  db: Kysely<unknown>,
  productId: string,
  authorId: string,
): Promise<ReviewRow | undefined> {
  const result = await sql`
    SELECT token, rating, title, body, review_moderation_state_id, created_at, updated_at
    FROM reviews.review
    WHERE product_id = ${productId} AND author_id = ${authorId}
  `.execute(db);
  const row = result.rows[0];
  return row === undefined ? undefined : rowAs(reviewRowSchema, row);
}

/**
 * The replay/conflict branch (SPEC-0004) — identical whether reached from the pre-transaction
 * state check (step 1) or from the post-rollback re-read after a unique-violation (step 6), so it
 * is written once and called from both. `existingRow` absent here means the row that justified
 * taking this branch was deleted in the interleaving between the read that found it and this
 * call — a race, never the ordinary "no review yet" case (that case never reaches this function).
 */
function replayOrConflict(
  existingRow: ReviewRow | undefined,
  input: SubmitReviewInput,
): SubmitReviewResult {
  if (existingRow === undefined) {
    throw new ConflictError(
      'the review this request raced with was removed before it could be read back',
      { details: { field: 'review' } },
    );
  }
  const isReplay =
    existingRow.rating === input.rating &&
    existingRow.title === input.title &&
    existingRow.body === input.body;
  if (isReplay) {
    return { review: toReviewRecord(input.productSlug, existingRow), replayed: true };
  }
  throw new ConflictError('you have already reviewed this product', {
    details: { field: 'review' },
  });
}

async function emitRatingRecompute(trx: Kysely<unknown>, productId: string): Promise<void> {
  await insertOutboxRows(trx, REVIEWS_OUTBOX, [
    { aggregateId: productId, op: RATING_RECOMPUTE_OP, payload: {} },
  ]);
}

/**
 * Review submission — ADR-0007's six steps, explicit:
 *
 * 1. **State check**, OUTSIDE any transaction: resolve `product_id` from `productSlug` (absent ->
 *    `NotFoundError`), then read any existing `(product_id, author_id)` review. Found -> the
 *    replay/conflict branch decides and returns/throws without ever opening a transaction.
 * 2. **Claim**: open the transaction; the FIRST statement inside is the advisory lock keyed by
 *    `(product_id, author_id)`, then the existing row is re-read UNDER the lock.
 * 3. **External call outside the transaction: there is none.** Review submission calls no
 *    provider — named here so the absence is a fact SPEC-0004 asks for, not an omission.
 * 4. **Write-ahead: not applicable**, for the same reason. Write-ahead exists to stop a PAID call
 *    from repeating on replay; with no call in step 3 there is no outcome to record ahead of
 *    anything. Idempotence here comes entirely from the natural key
 *    (`uq_review__product_id__author_id`), never from a write-ahead row.
 * 5. **Single commit**: `INSERT ... RETURNING` (never `ON CONFLICT DO NOTHING` — it would return
 *    zero rows for both replay and conflict, collapsing the two cases this task must tell apart;
 *    never `ON CONFLICT DO UPDATE` — it would silently overwrite another submission's content)
 *    plus `emitRatingRecompute` in the SAME transaction.
 * 6. **Typed failure**: the `catch` sits OUTSIDE `transaction().execute()` — a failed statement
 *    aborts the transaction, so the re-read after a unique-violation runs on the pooled `db`,
 *    AFTER rollback, never inside the aborted `trx`.
 */
export function submitReview(
  db: Kysely<unknown>,
  input: SubmitReviewInput,
): Promise<SubmitReviewResult> {
  return obs.withSpan('reviews.review.submit', async (span) => {
    const productId = await resolveProductId(db, input.productSlug);

    const beforeClaim = await readExistingReview(db, productId, input.authorId);
    if (beforeClaim !== undefined) {
      const result = replayOrConflict(beforeClaim, input);
      span.setAttributes({
        outcome: 'replayed',
        productSlug: input.productSlug,
        reviewToken: result.review.token,
      });
      return result;
    }

    let result: SubmitReviewResult;
    try {
      result = await db.transaction().execute(async (trx) => {
        await acquireReviewLock(trx, productId, input.authorId);

        const underLock = await readExistingReview(trx, productId, input.authorId);
        if (underLock !== undefined) {
          return replayOrConflict(underLock, input);
        }

        const insertResult = await sql`
          INSERT INTO reviews.review
            (token, product_id, author_id, rating, title, body, review_moderation_state_id)
          VALUES (
            ${mintToken(TOKEN_PREFIX.Review)}, ${productId}, ${input.authorId}, ${input.rating},
            ${input.title}, ${input.body}, ${REVIEW_MODERATION_STATE.Published.id}
          )
          RETURNING token, rating, title, body, review_moderation_state_id, created_at, updated_at
        `.execute(trx);
        const row = rowAs(reviewRowSchema, insertResult.rows[0]);

        await emitRatingRecompute(trx, productId);

        return { review: toReviewRecord(input.productSlug, row), replayed: false };
      });
    } catch (error) {
      // Only the one-review-per-author constraint means "someone else already wrote this review";
      // it is the sole violation the re-read below can explain. Any other 23505 — a `uq_review__
      // token` collision above all, which is this module's own minting colliding with itself —
      // gets the translator's classification instead. Funnelling both into the re-read would find
      // no row and answer with a message about a review the caller raced, which is not what
      // happened.
      if (uniqueViolationConstraintOf(error) !== UNIQUE_CONSTRAINT.ReviewAuthorPerProduct) {
        throw translateUniqueViolation(error) ?? error;
      }
      const afterRollback = await readExistingReview(db, productId, input.authorId);
      result = replayOrConflict(afterRollback, input);
    }

    span.setAttributes({
      outcome: result.replayed ? 'replayed' : 'created',
      productSlug: input.productSlug,
      reviewToken: result.review.token,
    });
    return result;
  });
}
