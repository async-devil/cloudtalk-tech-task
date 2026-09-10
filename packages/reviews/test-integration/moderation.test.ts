/**
 * TASK-0009's container-only acceptance criteria for review moderation (`reject`/`restore`,
 * SPEC-0001 rules 9-12, SPEC-0004): the state transition and its outbox row commit together, the
 * transition's effect on `listReviewsForProduct` and the rating projection, byte-identical restore,
 * and the no-op path's idempotence — all against a REAL Postgres, which is the only way to prove
 * "no window where the state changed and no recomputation was scheduled" (a fake db, as used in
 * `packages/reviews/test/moderation.test.ts`, can only prove which STATEMENTS were issued, never
 * that Postgres actually committed them together as one unit).
 *
 * HONESTY NOTE, read before trusting a green run of this file: this environment cannot start
 * Docker containers, so none of these tests have actually been RUN here — only written,
 * typechecked (via the throwaway `tsconfig` `typecheck-tests` builds against this file too), and
 * reasoned through by hand, following `outbox-relay-durability.test.ts`'s own precedent for the
 * identical situation. Every mutation comment below states what a reviewer should apply, watch go
 * red, and restore (ADR-0010) — none of those mutations were executed here either, for the same
 * reason; the identical no-op mutation this file's third test names WAS executed and observed
 * against a fake db in `packages/reviews/test/moderation.test.ts`, which is the strongest proof
 * available in this environment for that specific property.
 */
import { REVIEW_MODERATION_STATE } from '@repo/entities';
import { NotFoundError } from '@repo/kernel';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listReviewsForProduct,
  recomputeProductRating,
  setReviewModerationState,
  submitReview,
} from '../src/index.js';
import {
  createAppUser,
  createTestProduct,
  type ReviewsTestInfra,
  startReviewsTestInfra,
} from './harness/postgres-container.js';

async function countOutboxForProduct(db: Kysely<unknown>, productId: string): Promise<number> {
  const result = await sql`
    SELECT count(*)::int AS count FROM reviews.outbox WHERE aggregate_id = ${productId}
  `.execute(db);
  return (result.rows[0] as { count: number }).count;
}

async function fetchReviewRow(
  db: Kysely<unknown>,
  token: string,
): Promise<Record<string, unknown>> {
  const result = await sql`SELECT * FROM reviews.review WHERE token = ${token}`.execute(db);
  return result.rows[0] as Record<string, unknown>;
}

describe('setReviewModerationState (TASK-0009, SPEC-0001 rules 9-12, SPEC-0004)', () => {
  let infra: ReviewsTestInfra;

  beforeAll(async () => {
    infra = await startReviewsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  // TASK-0009's own named container criterion: "rejecting a review with an outstanding aggregate
  // commits the outbox row in the same transaction as the state change — no window where the
  // state changed and no recomputation was scheduled."
  //
  // Mutation: in `src/moderation.ts`'s `setReviewModerationState`, drop the
  // `await emitRatingRecompute(trx, before.product_id);` call from the transition branch — the
  // state still moves (the first two assertions stay green), but the outbox-count assertion goes
  // red (no new outbox row), and the final `recomputeProductRating` assertion goes red too: with
  // nothing having scheduled a recomputation, the projection would still be correct here only
  // because THIS test calls `recomputeProductRating` directly — in production nothing would ever
  // fix the aggregate, which is exactly the gap SPEC-0004 forbids.
  it('rejecting a review with an outstanding aggregate commits the outbox row in the same transaction as the state change', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    const submitted = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 5,
      title: 'A glowing review of this product',
      body: 'Everything about this purchase exceeded expectations by a wide margin.',
    });

    // An "outstanding aggregate" — a `product_rating` row reflecting the CURRENT (pre-rejection)
    // state, which the rejection below must invalidate via its OWN scheduled recomputation, not by
    // this call running again.
    const beforeRejection = await recomputeProductRating(infra.db, product.productId);
    expect(beforeRejection.reviewCount).toBe(1);

    const outboxBefore = await countOutboxForProduct(infra.db, product.productId);

    const rejected = await setReviewModerationState(infra.db, {
      reviewToken: submitted.review.token,
      targetState: 'rejected',
    });

    expect(rejected.moderationState).toBe('rejected');
    const row = await fetchReviewRow(infra.db, submitted.review.token);
    expect(row.review_moderation_state_id).toBe(REVIEW_MODERATION_STATE.Rejected.id);

    // The outbox row committed in the SAME transaction as the state change (SPEC-0004): asserted
    // as one read after the call resolves — either both landed (this assertion) or the call itself
    // would have thrown, rolling back the whole transaction, state change included.
    expect(await countOutboxForProduct(infra.db, product.productId)).toBe(outboxBefore + 1);

    // Proves the scheduled recomputation actually FIXES the now-stale aggregate: applying it (as
    // the relay eventually would, reading the outbox row this call just committed) drops the
    // rejected review out of the count entirely.
    const afterRecompute = await recomputeProductRating(infra.db, product.productId);
    expect(afterRecompute.reviewCount).toBe(0);
    expect(afterRecompute.ratingAverage).toBeNull();
  });

  // SPEC-0001 rule 11: a rejected review disappears from the product's review list without being
  // deleted. SPEC-0001 rule 10: restoring reverses it.
  //
  // Mutation: in `src/moderation.ts`, change the `UPDATE`'s `SET review_moderation_state_id =
  // ${targetStateId}` to always write `REVIEW_MODERATION_STATE.Published.id` regardless of
  // `input.targetState` — `reject` would then never actually remove the review, and the first
  // assertion below goes red.
  it('rejecting removes the review from listReviewsForProduct without deleting the row; restoring brings it back', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    const submitted = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 3,
      title: 'A review that will be rejected and restored',
      body: 'This review exercises the full reject-then-restore round trip end to end.',
    });

    await setReviewModerationState(infra.db, {
      reviewToken: submitted.review.token,
      targetState: 'rejected',
    });

    const afterReject = await listReviewsForProduct(infra.db, {
      productSlug: product.slug,
      limit: 20,
    });
    expect(afterReject.items.map((item) => item.token)).not.toContain(submitted.review.token);

    // Not deleted — the row is still there, just excluded from this scoped read.
    const rowAfterReject = await fetchReviewRow(infra.db, submitted.review.token);
    expect(rowAfterReject.review_moderation_state_id).toBe(REVIEW_MODERATION_STATE.Rejected.id);

    await setReviewModerationState(infra.db, {
      reviewToken: submitted.review.token,
      targetState: 'published',
    });

    const afterRestore = await listReviewsForProduct(infra.db, {
      productSlug: product.slug,
      limit: 20,
    });
    expect(afterRestore.items.map((item) => item.token)).toContain(submitted.review.token);
  });

  // TASK-0009's own acceptance criterion: "the restored row is byte-identical to the row before
  // rejection apart from updated_at."
  //
  // Mutation: in `src/moderation.ts`'s `setReviewModerationState`, change the `UPDATE`'s `SET`
  // clause to also touch an unrelated column (e.g. `SET review_moderation_state_id = ..., rating =
  // 1`) — the restored row's `rating` would then differ from the row before rejection, and this
  // test's `toStrictEqual` assertion goes red.
  it('restoring a rejected review yields a row byte-identical to before rejection, apart from updated_at', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    const submitted = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 2,
      title: 'A review whose row must survive a round trip intact',
      body: 'Rejecting and then restoring this review must not perturb any other column.',
    });
    const before = await fetchReviewRow(infra.db, submitted.review.token);

    await setReviewModerationState(infra.db, {
      reviewToken: submitted.review.token,
      targetState: 'rejected',
    });
    await setReviewModerationState(infra.db, {
      reviewToken: submitted.review.token,
      targetState: 'published',
    });

    const after = await fetchReviewRow(infra.db, submitted.review.token);
    const { updated_at: beforeUpdatedAt, ...beforeRest } = before;
    const { updated_at: afterUpdatedAt, ...afterRest } = after;
    expect(afterRest).toStrictEqual(beforeRest);
    expect((afterUpdatedAt as Date).getTime()).toBeGreaterThan((beforeUpdatedAt as Date).getTime());
  });

  // TASK-0009's own acceptance criterion: "Rejecting an already-rejected review ... is a no-op
  // that returns the current row and does not enqueue a second recomputation." The identical
  // mutation (deleting the early no-op branch) is PERFORMED AND OBSERVED against a fake db in
  // `packages/reviews/test/moderation.test.ts` (see that file's own header) — this container test
  // asserts the same property against REAL Postgres rather than repeating the mutation here.
  it('rejecting an already-rejected review is a no-op that enqueues no second outbox row', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    const submitted = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 1,
      title: 'A review rejected twice in a row',
      body: 'The second rejection must not schedule a second, redundant recomputation.',
    });

    const firstReject = await setReviewModerationState(infra.db, {
      reviewToken: submitted.review.token,
      targetState: 'rejected',
    });
    const outboxAfterFirst = await countOutboxForProduct(infra.db, product.productId);

    const secondReject = await setReviewModerationState(infra.db, {
      reviewToken: submitted.review.token,
      targetState: 'rejected',
    });

    expect(secondReject.updatedAt).toStrictEqual(firstReject.updatedAt);
    expect(await countOutboxForProduct(infra.db, product.productId)).toBe(outboxAfterFirst);
  });

  it('rejecting an unknown token throws NotFoundError', async () => {
    await expect(
      setReviewModerationState(infra.db, {
        reviewToken: 'rev_doesNotExistAtAll0000',
        targetState: 'rejected',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });
});
