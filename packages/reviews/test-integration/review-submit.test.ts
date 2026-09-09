import { OUTBOX_ROW_STATUS } from '@repo/entities';
import { ConflictError, NotFoundError } from '@repo/kernel';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { submitReview } from '../src/index.js';
import {
  createAppUser,
  createTestProduct,
  type ReviewsTestInfra,
  startReviewsTestInfra,
} from './harness/postgres-container.js';

async function countReviews(
  db: Kysely<unknown>,
  productId: string,
  authorId: string,
): Promise<number> {
  const result = await sql`
    SELECT count(*)::int AS count FROM reviews.review
    WHERE product_id = ${productId} AND author_id = ${authorId}
  `.execute(db);
  return (result.rows[0] as { count: number }).count;
}

async function countOutboxForProduct(db: Kysely<unknown>, productId: string): Promise<number> {
  const result = await sql`
    SELECT count(*)::int AS count FROM reviews.outbox WHERE aggregate_id = ${productId}
  `.execute(db);
  return (result.rows[0] as { count: number }).count;
}

async function countAllReviews(db: Kysely<unknown>): Promise<number> {
  const result = await sql`SELECT count(*)::int AS count FROM reviews.review`.execute(db);
  return (result.rows[0] as { count: number }).count;
}

/** The count of committed reviews with no matching outbox row for their product — casts
 * `review.product_id` (uuid) to `text` to compare against `outbox.aggregate_id` (text), per
 * SPEC-0004's event shape (`aggregate_id` is the product's internal id, carried as text). */
async function orphanReviewCount(db: Kysely<unknown>): Promise<number> {
  const result = await sql`
    SELECT count(*)::int AS count
    FROM reviews.review r
    WHERE NOT EXISTS (
      SELECT 1 FROM reviews.outbox o
      WHERE o.aggregate_id = r.product_id::text AND o.op = 'rating.recompute'
    )
  `.execute(db);
  return (result.rows[0] as { count: number }).count;
}

describe('submitReview (TASK-0002, SPEC-0004)', () => {
  let infra: ReviewsTestInfra;

  beforeAll(async () => {
    infra = await startReviewsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  // Mutation: in `src/reviews.ts`'s `submitReview`, delete the
  // `await emitRatingRecompute(trx, productId);` line — `outboxRows.rows` is then empty and this
  // assertion goes red.
  it('one submission writes exactly one review row and one outbox row (aggregate_id=product_id, op=rating.recompute, payload={}, pending)', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);

    const result = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 5,
      title: 'Excellent purchase overall',
      body: 'This product exceeded my expectations in every way I can think of.',
    });
    expect(result.replayed).toBe(false);

    expect(await countReviews(infra.db, product.productId, authorId)).toBe(1);

    const outboxRows = await sql`
      SELECT aggregate_id, op, payload, outbox_row_status_id
      FROM reviews.outbox WHERE aggregate_id = ${product.productId}
    `.execute(infra.db);
    expect(outboxRows.rows).toStrictEqual([
      {
        aggregate_id: product.productId,
        op: 'rating.recompute',
        payload: {},
        outbox_row_status_id: OUTBOX_ROW_STATUS.Pending.id,
      },
    ]);
  });

  // THE global durability assertion (TASK-0002's own words: "a container test asserts that no
  // committed review lacks an outbox row"). Submits across several distinct products and authors
  // first, so the query is proving something over more than one lucky row.
  //
  // Mutation: in `src/reviews.ts`'s `submitReview`, move `await emitRatingRecompute(trx,
  // productId);` out of the transaction callback AND make it fail before it writes — i.e. after
  // `db.transaction().execute(...)` resolves, `throw new Error('crash')` where the emit used to
  // be. The review row is committed and no outbox row exists, so `orphanReviewCount` returns a
  // non-zero count and this goes red.
  //
  // The throw is the load-bearing half of that mutation, not decoration. Merely relocating the
  // emit to after the commit still writes both rows on a happy path, so this assertion would stay
  // green while the atomicity guarantee was already gone — which is exactly the kind of mutation
  // that proves nothing. What is being protected here is ADR-0007 step 5 ("single commit"): not
  // that both rows exist, but that no interruption can leave the first without the second.
  it('no committed review ever lacks a matching outbox row, across several products and authors', async () => {
    const productA = await createTestProduct(infra.db);
    const productB = await createTestProduct(infra.db);
    const authorX = await createAppUser(infra.db);
    const authorY = await createAppUser(infra.db);
    const authorZ = await createAppUser(infra.db);

    await submitReview(infra.db, {
      productSlug: productA.slug,
      authorId: authorX,
      rating: 4,
      title: 'Solid everyday choice',
      body: 'Works exactly as described and holds up to daily use fine.',
    });
    await submitReview(infra.db, {
      productSlug: productA.slug,
      authorId: authorY,
      rating: 2,
      title: 'Disappointed with this one',
      body: 'Stopped working properly after just a couple of weeks of use.',
    });
    await submitReview(infra.db, {
      productSlug: productB.slug,
      authorId: authorX,
      rating: 5,
      title: 'Would buy again for sure',
      body: 'Second one I have bought, just as good as the first purchase.',
    });
    await submitReview(infra.db, {
      productSlug: productB.slug,
      authorId: authorZ,
      rating: 3,
      title: 'Average, nothing special',
      body: 'Does the job but there are better options at this price point.',
    });

    expect(await orphanReviewCount(infra.db)).toBe(0);
  });

  // Mutation: in `src/reviews.ts`'s `replayOrConflict`, hardcode `isReplay` to `false` — the
  // second call then throws `ConflictError` instead of returning `replayed: true`, and this
  // test's first assertion goes red.
  it('an identical resubmission returns the same token with replayed=true, leaves review count at 1 and outbox count at 1', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    const input = {
      productSlug: product.slug,
      authorId,
      rating: 4,
      title: 'A solid pick overall',
      body: 'Works exactly as described, and I would buy it again.',
    };

    const first = await submitReview(infra.db, input);
    expect(first.replayed).toBe(false);

    const second = await submitReview(infra.db, input);
    expect(second.replayed).toBe(true);
    expect(second.review.token).toBe(first.review.token);

    expect(await countReviews(infra.db, product.productId, authorId)).toBe(1);
    expect(await countOutboxForProduct(infra.db, product.productId)).toBe(1);
  });

  // Mutation: in `src/reviews.ts`'s `replayOrConflict`, change the differing-content branch to
  // `UPDATE` the existing row instead of throwing `ConflictError` — the stored content below
  // would change to the second submission's, and the final assertion goes red (no `ConflictError`
  // is thrown at all, so the earlier `toBeInstanceOf` assertion goes red first).
  it('a different-content resubmission throws ConflictError({ field: "review" }), leaving one row, one outbox row, and the stored content unchanged', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);

    await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 5,
      title: 'Loved it from day one',
      body: 'Exactly as advertised and it arrived quickly too.',
    });

    let caught: unknown;
    try {
      await submitReview(infra.db, {
        productSlug: product.slug,
        authorId,
        rating: 2,
        title: 'Actually changed my mind',
        body: 'Changed my mind about this after a week of using it.',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).details).toEqual({ field: 'review' });

    expect(await countReviews(infra.db, product.productId, authorId)).toBe(1);
    expect(await countOutboxForProduct(infra.db, product.productId)).toBe(1);

    const stored = await sql`
      SELECT rating, title, body FROM reviews.review
      WHERE product_id = ${product.productId} AND author_id = ${authorId}
    `.execute(infra.db);
    expect(stored.rows[0]).toStrictEqual({
      rating: 5,
      title: 'Loved it from day one',
      body: 'Exactly as advertised and it arrived quickly too.',
    });
  });

  // Mutation: in `src/reviews.ts`'s `submitReview`, remove `acquireReviewLock(trx, ...)` (the
  // first statement inside the transaction) — both concurrent submissions can then pass the
  // `underLock` re-read before either has inserted, and this test either produces two review
  // rows / two outbox rows for the same (product, author) pair or flakes between runs instead of
  // consistently landing at exactly one of each.
  it('two concurrent submissions from one author via Promise.all produce exactly one review row and one outbox row; the loser gets ConflictError', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);

    const attempt = (rating: number, title: string, body: string) =>
      submitReview(infra.db, { productSlug: product.slug, authorId, rating, title, body })
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error }));

    const [first, second] = await Promise.all([
      attempt(5, 'First racing submission', 'The first of two submissions racing on purpose.'),
      attempt(1, 'Second racing submission', 'The second of two submissions racing on purpose.'),
    ]);

    const outcomes = [first, second];
    const winners = outcomes.filter((outcome) => outcome.ok);
    const losers = outcomes.filter((outcome) => !outcome.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect((losers[0] as { ok: false; error: unknown }).error).toBeInstanceOf(ConflictError);

    expect(await countReviews(infra.db, product.productId, authorId)).toBe(1);
    expect(await countOutboxForProduct(infra.db, product.productId)).toBe(1);
  });

  // Mutation: in `src/internal/resolve-product.ts`'s `resolveProductId`, drop the
  // `if (row === undefined)` check (return an arbitrary/undefined id instead of throwing
  // `NotFoundError`) — the subsequent write either fails on the foreign key with a raw driver
  // error instead of a typed one, or silently addresses the wrong row, and this test goes red.
  it('an unknown slug throws NotFoundError and writes nothing', async () => {
    const authorId = await createAppUser(infra.db);
    const before = await countAllReviews(infra.db);

    await expect(
      submitReview(infra.db, {
        productSlug: 'no-such-product-slug-at-all',
        authorId,
        rating: 4,
        title: 'Does not matter at all',
        body: 'This body text is long enough to pass validation checks.',
      }),
    ).rejects.toBeInstanceOf(NotFoundError);

    expect(await countAllReviews(infra.db)).toBe(before);
  });
});
