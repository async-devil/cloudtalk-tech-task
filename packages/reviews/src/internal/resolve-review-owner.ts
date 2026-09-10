import { ForbiddenError } from '@repo/kernel';
import { rowAs } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import { reviewOwnerRowSchema } from './rows.js';

/**
 * The one answer "not this session's review" ever gives (SPEC-0001 rule 5, SPEC-0003): another
 * author's review and a token that names no row at all both throw exactly this, so
 * `updateReview`/`removeReview` are never an existence oracle. Exported so both this file's
 * pre-transaction check and each mutation's post-lock re-check throw the identical instance shape.
 */
export function notOwnedError(): ForbiddenError {
  return new ForbiddenError('this session does not own that review', {
    details: { field: 'review' },
  });
}

/**
 * `updateReview`/`removeReview`'s shared ADR-0007 step 1 (state check, outside any transaction):
 * resolves `reviewToken`'s `product_id` — needed for the advisory lock and the outbox row's
 * `aggregate_id` — while deciding `FORBIDDEN` up front, before either mutation ever opens a
 * transaction. Never `NotFoundError`: {@link notOwnedError} either way, so a caller cannot use
 * either write route to probe whether a token exists.
 * @throws ForbiddenError
 */
export async function resolveReviewProductForOwner(
  db: Kysely<unknown>,
  reviewToken: string,
  authorId: string,
): Promise<string> {
  const result = await sql`
    SELECT product_id, author_id FROM reviews.review WHERE token = ${reviewToken}
  `.execute(db);
  const row = result.rows[0];
  if (row === undefined) {
    throw notOwnedError();
  }
  const owner = rowAs(reviewOwnerRowSchema, row);
  if (owner.author_id !== authorId) {
    throw notOwnedError();
  }
  return owner.product_id;
}
