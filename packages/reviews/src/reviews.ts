import {
  mintToken,
  REVIEW_MODERATION_STATE,
  type ReviewModerationStateName,
  TOKEN_PREFIX,
} from '@repo/entities';
import { ConflictError, ValidationError } from '@repo/kernel';
import { rowAs, rowsAs } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { acquireReviewLock } from './internal/advisory-lock.js';
import { decodeCursor, encodeCursor } from './internal/cursor.js';
import { emitRatingRecompute } from './internal/emit-rating-recompute.js';
import { obs } from './internal/observability.js';
import { reviewModerationStateNameFor } from './internal/reference-ids.js';
import { resolveProductId } from './internal/resolve-product.js';
import { notOwnedError, resolveReviewProductForOwner } from './internal/resolve-review-owner.js';
import { reviewListRowSchema, reviewMutationRowSchema, reviewRowSchema } from './internal/rows.js';
import {
  translateUniqueViolation,
  UNIQUE_CONSTRAINT,
  uniqueViolationConstraintOf,
} from './internal/unique-violation.js';

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

// ---------------------------------------------------------------------------------------------
// listReviewsForProduct (TASK-0003, SPEC-0003) — the AUTHORITATIVE read `products.*` deliberately
// does not do. Reads `reviews.review` directly, never the rating projection (ADR-0014), which is
// why an author sees their own review immediately: no recomputation has to run first. That split
// is the whole point of the projection and is visible here in which table this function's `FROM`
// names, with no comment required to say so.
// ---------------------------------------------------------------------------------------------

/**
 * One review as `listReviewsForProduct` hands it back.
 *
 * `authorId` is a DELIBERATE, NARROW EXCEPTION to this module's "no internal uuid crosses the
 * public contract" rule (contrast `ReviewRecord` above, which has none). The router (`apps/api`)
 * needs to correlate a review with its author across the `auth` bounded context for two wire
 * fields this module cannot produce itself: `authoredByViewer` (compare against the CALLING
 * session's own id) and `authorLabel` (the author's email's local part — `auth.identity.email`
 * lives in a schema this module never queries). `reviews` has no sanctioned Tier-2 edge to
 * `@repo/auth` (`tools/arch-checks/src/module-registry.cjs`), so the composition root is the only
 * place those two facts can be joined, which means this module has to hand back enough to let it.
 * `reviewSummarySchema` (`@repo/contracts`) has no `authorId` field, so the router's own
 * object-literal return type is what keeps this value from ever reaching the wire.
 *
 * NEVER log this value, put it on a span attribute, or a metric (ADR-0009) — treat it exactly as
 * `submitReview`'s `authorId` INPUT is already treated everywhere else in this file.
 */
export interface ReviewListItem {
  readonly token: string;
  readonly rating: number;
  readonly title: string;
  readonly body: string;
  readonly authorId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ReviewListPage {
  readonly items: readonly ReviewListItem[];
  readonly nextCursor: string | null;
}

export interface ListReviewsForProductInput {
  readonly productSlug: string;
  /** Opaque keyset cursor on `(created_at, token)`, newest first — see this schema's own doc for
   * why `token` stands in for `review_id` here. */
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * The opaque cursor's decoded shape. `productSlug` pins it to the product it was minted for — a
 * cursor from a different product is rejected as `VALIDATION` (SPEC-0003) — and `token`/`createdAt`
 * are the keyset pair.
 *
 * **Keyed on `(created_at, token)`, not `(created_at, review_id)`** as SPEC-0003's prose names the
 * pair: `review_id` is an internal uuid, and encoding it into a cursor that round-trips through the
 * client would put an internal uuid ON THE WIRE, opaque or not — exactly what ADR-0016 forbids. A
 * review's `token` is already a public identifier serialized on every row, is already unique
 * (`uq_review__token`), and gives keyset pagination the same "never skip or repeat a row" guarantee
 * `review_id` would — the property SPEC-0003 actually cares about, which does not depend on which
 * unique column supplies the tie-break.
 */
const reviewListCursorSchema = z.object({
  v: z.literal(1),
  productSlug: z.string(),
  createdAt: z.string(),
  token: z.string(),
});

/**
 * `reviews.listForProduct`'s read (TASK-0003, SPEC-0003): newest first, keyset-paginated, only
 * `published` reviews (SPEC-0002). Reads the AUTHORITATIVE table — see this section's header note.
 * `input.limit` is trusted as already validated, the same precedent `listProducts` documents.
 * @throws NotFoundError when no product has this slug.
 * @throws ValidationError when `cursor` does not decode, or names a different product.
 */
export function listReviewsForProduct(
  db: Kysely<unknown>,
  input: ListReviewsForProductInput,
): Promise<ReviewListPage> {
  return obs.withSpan('reviews.review.list', async () => {
    const productId = await resolveProductId(db, input.productSlug);

    let cursorFilter = sql``;
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor, reviewListCursorSchema);
      if (cursor.productSlug !== input.productSlug) {
        throw new ValidationError('cursor does not match this product', {
          details: { field: 'cursor' },
        });
      }
      cursorFilter = sql`
        AND (created_at < ${cursor.createdAt}::timestamptz
             OR (created_at = ${cursor.createdAt}::timestamptz AND token < ${cursor.token}))
      `;
    }

    const result = await sql`
      SELECT token, rating, title, body, author_id, created_at, updated_at
      FROM reviews.review
      WHERE product_id = ${productId}
        AND review_moderation_state_id = ${REVIEW_MODERATION_STATE.Published.id}
        ${cursorFilter}
      ORDER BY created_at DESC, token DESC
      LIMIT ${input.limit + 1}
    `.execute(db);
    const rows = rowsAs(reviewListRowSchema, result.rows);

    const page = rows.slice(0, input.limit);
    const hasMore = rows.length > input.limit;
    const last = page[page.length - 1];
    const nextCursor: string | null =
      hasMore && last !== undefined
        ? encodeCursor({
            v: 1,
            productSlug: input.productSlug,
            createdAt: last.created_at.toISOString(),
            token: last.token,
          } satisfies z.infer<typeof reviewListCursorSchema>)
        : null;

    return {
      items: page.map((row) => ({
        token: row.token,
        rating: row.rating,
        title: row.title,
        body: row.body,
        authorId: row.author_id,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
      nextCursor,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// updateReview / removeReview (TASK-0003, SPEC-0001 rules 5-7, SPEC-0004) — ADR-0007's six-step
// shape again, shorter than submitReview's: there is no natural-key replay/conflict branch to
// decide, so the "state check" step's whole job is the ownership guard
// (`resolveReviewProductForOwner`), and the mutation's own `WHERE token = … AND author_id = …`
// re-asserts that same guard atomically at commit time. Both emit the identical
// `rating.recompute` outbox row `submitReview` does, in the SAME transaction (SPEC-0004:
// submission, edit and deletion emit one event).
// ---------------------------------------------------------------------------------------------

export interface UpdateReviewInput {
  readonly reviewToken: string;
  /** The ACTING session's internal id — resolved by the caller, never looked up here (the same
   * precedent `SubmitReviewInput.authorId` sets). */
  readonly authorId: string;
  readonly rating?: number;
  readonly title?: string;
  readonly body?: string;
}

/** `updateReview`'s result: no `moderationState` (an edit never touches it) and no `productSlug`
 * (the caller already has it, or has no use for it — `reviewSummarySchema` carries neither). */
export interface ReviewMutationRecord {
  readonly token: string;
  readonly rating: number;
  readonly title: string;
  readonly body: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/**
 * Editing one's own review (SPEC-0001 rule 6, SPEC-0003 `reviews.update`) — ADR-0007's six steps:
 *
 * 1. **State check**, outside any transaction: {@link resolveReviewProductForOwner} resolves the
 *    review's `product_id`, throwing `ForbiddenError` for a token that does not exist OR does not
 *    belong to `input.authorId` — the identical answer either way (SPEC-0001 rule 5).
 * 2. **Claim**: the transaction's FIRST statement is the advisory lock keyed by
 *    `(product_id, author_id)` — the SAME lock `submitReview` takes, so an edit can never
 *    interleave with that function's own insert-or-replay decision for the same pair.
 * 3. **External call**: none.
 * 4. **Write-ahead**: not applicable, for the reason `submitReview` gives.
 * 5. **Single commit**: `UPDATE … WHERE token = … AND author_id = … RETURNING …` re-asserts
 *    ownership IN the statement itself — the guard against the row being deleted in the gap
 *    between step 1's read and the lock — `COALESCE` leaves every field the caller omitted
 *    untouched, and `tg_review__set_updated_at` is what moves `updated_at` (the "edited" marker's
 *    whole signal — `created_at` never moves, SPEC-0001 rule 6), plus `emitRatingRecompute` in the
 *    SAME transaction.
 * 6. **Typed failure**: zero rows back from the `UPDATE` means the race above happened — thrown as
 *    the SAME `ForbiddenError` step 1 would have thrown, never a raw "no rows" surprise.
 */
export function updateReview(
  db: Kysely<unknown>,
  input: UpdateReviewInput,
): Promise<ReviewMutationRecord> {
  return obs.withSpan('reviews.review.update', async () => {
    const productId = await resolveReviewProductForOwner(db, input.reviewToken, input.authorId);

    return db.transaction().execute(async (trx) => {
      await acquireReviewLock(trx, productId, input.authorId);

      const result = await sql`
        UPDATE reviews.review
        SET rating = COALESCE(${input.rating ?? null}, rating),
            title  = COALESCE(${input.title ?? null}, title),
            body   = COALESCE(${input.body ?? null}, body)
        WHERE token = ${input.reviewToken} AND author_id = ${input.authorId}
        RETURNING token, rating, title, body, created_at, updated_at
      `.execute(trx);
      const row = result.rows[0];
      if (row === undefined) {
        throw notOwnedError();
      }
      const updated = rowAs(reviewMutationRowSchema, row);

      await emitRatingRecompute(trx, productId);

      return {
        token: updated.token,
        rating: updated.rating,
        title: updated.title,
        body: updated.body,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      };
    });
  });
}

export interface RemoveReviewInput {
  readonly reviewToken: string;
  /** The ACTING session's internal id — same precedent as {@link UpdateReviewInput.authorId}. */
  readonly authorId: string;
}

/**
 * Deleting one's own review (SPEC-0001 rule 7, SPEC-0003 `reviews.remove`) — the same shape as
 * {@link updateReview}, ending in a `DELETE … RETURNING` instead of an `UPDATE`. The aggregate
 * follows on the next recomputation (SPEC-0001 rule 7): the deletion and its outbox row commit
 * together, exactly like every other write on this table (SPEC-0004).
 * @throws ForbiddenError when `reviewToken` does not exist or does not belong to `input.authorId`.
 */
export function removeReview(db: Kysely<unknown>, input: RemoveReviewInput): Promise<void> {
  return obs.withSpan('reviews.review.remove', async () => {
    const productId = await resolveReviewProductForOwner(db, input.reviewToken, input.authorId);

    await db.transaction().execute(async (trx) => {
      await acquireReviewLock(trx, productId, input.authorId);

      const result = await sql`
        DELETE FROM reviews.review
        WHERE token = ${input.reviewToken} AND author_id = ${input.authorId}
        RETURNING review_id
      `.execute(trx);
      if (result.rows.length === 0) {
        throw notOwnedError();
      }

      await emitRatingRecompute(trx, productId);
    });
  });
}
