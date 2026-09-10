import { REVIEW_MODERATION_STATE } from '@repo/entities';
import { ForbiddenError, ValidationError } from '@repo/kernel';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listReviewsForProduct, removeReview, submitReview, updateReview } from '../src/index.js';
import {
  createAppUser,
  createTestProduct,
  type ReviewsTestInfra,
  startReviewsTestInfra,
} from './harness/postgres-container.js';

/** Narrows a page's `nextCursor` (`string | null`) to `string` — see
 * `product-list.test.ts`'s identical helper for why. */
function requireCursor(nextCursor: string | null): string {
  if (nextCursor === null) {
    throw new Error('expected a non-null nextCursor');
  }
  return nextCursor;
}

async function countOutboxForProduct(db: Kysely<unknown>, productId: string): Promise<number> {
  const result = await sql`
    SELECT count(*)::int AS count FROM reviews.outbox WHERE aggregate_id = ${productId}
  `.execute(db);
  return (result.rows[0] as { count: number }).count;
}

async function countReviewRows(db: Kysely<unknown>, productId: string): Promise<number> {
  const result = await sql`
    SELECT count(*)::int AS count FROM reviews.review WHERE product_id = ${productId}
  `.execute(db);
  return (result.rows[0] as { count: number }).count;
}

describe('listReviewsForProduct (TASK-0003, SPEC-0001, SPEC-0003, ADR-0014)', () => {
  let infra: ReviewsTestInfra;

  beforeAll(async () => {
    infra = await startReviewsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  // THE read-split assertion this route exists to prove (TASK-0003's note): a submission is
  // visible in the review list IMMEDIATELY, with no recomputation ever run — the authoritative
  // table, not the projection (ADR-0014).
  //
  // Mutation: in `src/reviews.ts`'s `listReviewsForProduct`, change the query's `FROM` to read
  // `reviews.product_rating` (or join through it) instead of `reviews.review` directly — a
  // freshly submitted, never-recomputed review would then be invisible, and the assertion below
  // goes red.
  it('a freshly submitted review is visible immediately, before any recomputation runs', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    const submitted = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 4,
      title: 'Visible the moment it lands',
      body: 'No recomputation has run yet and this should already show up.',
    });

    const page = await listReviewsForProduct(infra.db, { productSlug: product.slug, limit: 20 });
    expect(page.items.map((item) => item.token)).toContain(submitted.review.token);
  });

  // Mutation: in `src/reviews.ts`'s `listReviewsForProduct`, drop
  // `AND review_moderation_state_id = ${REVIEW_MODERATION_STATE.Published.id}` — the rejected
  // review would reappear in the list and the assertion below goes red.
  it('excludes a rejected review from the list (SPEC-0001 rule 11)', async () => {
    const product = await createTestProduct(infra.db);
    const publishedAuthor = await createAppUser(infra.db);
    const rejectedAuthor = await createAppUser(infra.db);
    await submitReview(infra.db, {
      productSlug: product.slug,
      authorId: publishedAuthor,
      rating: 5,
      title: 'A perfectly ordinary review',
      body: 'Nothing controversial here, just an honest opinion shared.',
    });
    const rejected = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId: rejectedAuthor,
      rating: 1,
      title: 'This one gets rejected later',
      body: 'Simulating a moderator rejection directly on this row.',
    });
    await sql`
      UPDATE reviews.review SET review_moderation_state_id = ${REVIEW_MODERATION_STATE.Rejected.id}
      WHERE token = ${rejected.review.token}
    `.execute(infra.db);

    const page = await listReviewsForProduct(infra.db, { productSlug: product.slug, limit: 20 });
    expect(page.items.map((item) => item.token)).not.toContain(rejected.review.token);
  });

  // Mutation: in `src/reviews.ts`'s `listReviewsForProduct`, change `LIMIT ${input.limit + 1}` to
  // `LIMIT ${input.limit}` — the next-page detection breaks, `nextCursor` is reported `null` on a
  // page that is not actually last, and `secondPage.items` comes back empty instead of holding the
  // remaining review.
  it('keyset-paginates newest first with no skip or repeat across pages', async () => {
    const product = await createTestProduct(infra.db);
    const authorA = await createAppUser(infra.db);
    const authorB = await createAppUser(infra.db);
    const authorC = await createAppUser(infra.db);

    const first = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId: authorA,
      rating: 3,
      title: 'The first review submitted here',
      body: 'Submitted first, so it should be oldest in the list.',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId: authorB,
      rating: 4,
      title: 'The second review submitted here',
      body: 'Submitted second, landing in the middle of the order.',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const third = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId: authorC,
      rating: 5,
      title: 'The third review submitted here',
      body: 'Submitted last, so it should be newest in the list.',
    });

    const firstPage = await listReviewsForProduct(infra.db, {
      productSlug: product.slug,
      limit: 2,
    });
    expect(firstPage.items.map((item) => item.token)).toEqual([
      third.review.token,
      second.review.token,
    ]);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await listReviewsForProduct(infra.db, {
      productSlug: product.slug,
      limit: 2,
      cursor: requireCursor(firstPage.nextCursor),
    });
    expect(secondPage.items.map((item) => item.token)).toEqual([first.review.token]);
    expect(secondPage.nextCursor).toBeNull();
  });

  // Mutation: in `src/reviews.ts`'s `listReviewsForProduct`, delete the
  // `if (cursor.productSlug !== input.productSlug)` check — a cursor minted for one product would
  // silently page through a completely different product's reviews instead of being rejected, and
  // this test's `ValidationError` expectation goes red.
  it('rejects a cursor minted for a different product as VALIDATION', async () => {
    const productA = await createTestProduct(infra.db);
    const productB = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    await submitReview(infra.db, {
      productSlug: productA.slug,
      authorId,
      rating: 4,
      title: 'A review that lives on product A',
      body: "This review's cursor should never work against product B.",
    });

    // A cursor is only minted once there is a next page, so a second review on product A is
    // needed before `nextCursor` is non-null.
    const authorId2 = await createAppUser(infra.db);
    await submitReview(infra.db, {
      productSlug: productA.slug,
      authorId: authorId2,
      rating: 2,
      title: 'A second review on product A',
      body: 'Added so a real pagination cursor exists to reuse below.',
    });
    const realFirstPage = await listReviewsForProduct(infra.db, {
      productSlug: productA.slug,
      limit: 1,
    });
    expect(realFirstPage.nextCursor).not.toBeNull();

    await expect(
      listReviewsForProduct(infra.db, {
        productSlug: productB.slug,
        limit: 1,
        cursor: requireCursor(realFirstPage.nextCursor),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('updateReview / removeReview (TASK-0003, SPEC-0001 rules 5-7, SPEC-0004)', () => {
  let infra: ReviewsTestInfra;

  beforeAll(async () => {
    infra = await startReviewsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  // Mutation: in `src/reviews.ts`'s `updateReview`, drop `await emitRatingRecompute(trx,
  // productId);` — the outbox count stays at 1 (submission's own row) instead of moving to 2, and
  // this test's final assertion goes red. This is SPEC-0004's "edit emits the identical event a
  // submission does."
  it("edits the caller's own review: preserves createdAt, moves updatedAt, updates fields, and emits a second recompute event", async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    const submitted = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 3,
      title: 'My first impression of this',
      body: 'It seemed fine at first but I want to revise this review.',
    });
    const outboxBefore = await countOutboxForProduct(infra.db, product.productId);

    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated = await updateReview(infra.db, {
      reviewToken: submitted.review.token,
      authorId,
      rating: 5,
      title: 'My revised opinion after using it',
    });

    expect(updated.token).toBe(submitted.review.token);
    expect(updated.rating).toBe(5);
    expect(updated.title).toBe('My revised opinion after using it');
    expect(updated.body).toBe(submitted.review.body); // omitted field left untouched
    expect(updated.createdAt).toStrictEqual(submitted.review.createdAt);
    expect(updated.updatedAt.getTime()).toBeGreaterThan(submitted.review.updatedAt.getTime());

    expect(await countOutboxForProduct(infra.db, product.productId)).toBe(outboxBefore + 1);
  });

  // SPEC-0001 rule 5 / SPEC-0003: another author's review is FORBIDDEN, and so is one that does
  // not exist — the SAME error, so this is not an existence oracle.
  //
  // Mutation: in `src/internal/resolve-review-owner.ts`'s `resolveReviewProductForOwner`, change
  // `if (owner.author_id !== authorId)` to `if (false)` — editing another author's review would
  // then succeed instead of throwing, and the first assertion goes red.
  it("editing another author's review, and editing a token that does not exist, both throw the identical ForbiddenError", async () => {
    const product = await createTestProduct(infra.db);
    const owner = await createAppUser(infra.db);
    const intruder = await createAppUser(infra.db);
    const submitted = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId: owner,
      rating: 4,
      title: 'This review belongs to its author',
      body: 'Only the original author should ever be able to edit this.',
    });

    let otherAuthorError: unknown;
    try {
      await updateReview(infra.db, {
        reviewToken: submitted.review.token,
        authorId: intruder,
        title: 'An intruder trying to rewrite this review',
      });
    } catch (error) {
      otherAuthorError = error;
    }
    expect(otherAuthorError).toBeInstanceOf(ForbiddenError);

    let missingTokenError: unknown;
    try {
      await updateReview(infra.db, {
        reviewToken: 'rev_doesNotExistAtAll0000',
        authorId: intruder,
        title: 'Trying to edit a token that was never minted',
      });
    } catch (error) {
      missingTokenError = error;
    }
    expect(missingTokenError).toBeInstanceOf(ForbiddenError);

    expect((otherAuthorError as ForbiddenError).message).toBe(
      (missingTokenError as ForbiddenError).message,
    );
    expect((otherAuthorError as ForbiddenError).details).toEqual(
      (missingTokenError as ForbiddenError).details,
    );

    // And the row itself is untouched.
    const untouched = await sql`
      SELECT title FROM reviews.review WHERE token = ${submitted.review.token}
    `.execute(infra.db);
    expect((untouched.rows[0] as { title: string }).title).toBe(
      'This review belongs to its author',
    );
  });

  // Mutation: in `src/reviews.ts`'s `removeReview`, drop `await emitRatingRecompute(trx,
  // productId);` — the outbox count assertion goes red.
  it("deletes the caller's own review and emits a recompute event (SPEC-0001 rule 7)", async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    const submitted = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 2,
      title: 'A review that will soon be deleted',
      body: 'This review only exists briefly to prove deletion works.',
    });
    const outboxBefore = await countOutboxForProduct(infra.db, product.productId);
    const reviewCountBefore = await countReviewRows(infra.db, product.productId);

    await removeReview(infra.db, { reviewToken: submitted.review.token, authorId });

    expect(await countReviewRows(infra.db, product.productId)).toBe(reviewCountBefore - 1);
    expect(await countOutboxForProduct(infra.db, product.productId)).toBe(outboxBefore + 1);

    const row = await sql`
      SELECT 1 FROM reviews.review WHERE token = ${submitted.review.token}
    `.execute(infra.db);
    expect(row.rows).toHaveLength(0);
  });

  // Mutation: in `src/reviews.ts`'s `removeReview`, remove the `AND author_id = ${input.authorId}`
  // clause from the `DELETE` statement — another author's `removeReview` call would then actually
  // delete the row instead of throwing `ForbiddenError`, and both assertions below go red.
  it("deleting another author's review throws ForbiddenError and leaves the row intact", async () => {
    const product = await createTestProduct(infra.db);
    const owner = await createAppUser(infra.db);
    const intruder = await createAppUser(infra.db);
    const submitted = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId: owner,
      rating: 5,
      title: 'A review someone else should not delete',
      body: 'Only the true author may ever remove this specific review.',
    });

    await expect(
      removeReview(infra.db, { reviewToken: submitted.review.token, authorId: intruder }),
    ).rejects.toBeInstanceOf(ForbiddenError);

    const row = await sql`
      SELECT 1 FROM reviews.review WHERE token = ${submitted.review.token}
    `.execute(infra.db);
    expect(row.rows).toHaveLength(1);
  });

  it('deleting a token that does not exist throws the same ForbiddenError, not NotFoundError', async () => {
    const authorId = await createAppUser(infra.db);
    await expect(
      removeReview(infra.db, { reviewToken: 'rev_alsoDoesNotExist000', authorId }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
