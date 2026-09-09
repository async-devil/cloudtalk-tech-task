import { REVIEW_MODERATION_STATE } from '@repo/entities';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { rebuildProductRating, submitReview } from '../src/index.js';
import {
  createAppUser,
  createTestProduct,
  type ReviewsTestInfra,
  startReviewsTestInfra,
} from './harness/postgres-container.js';

interface ProductRatingRow {
  readonly review_count: number;
  readonly rating_average: string | null;
  readonly computed_at: Date;
}

async function fetchProductRating(
  db: Kysely<unknown>,
  productId: string,
): Promise<ProductRatingRow> {
  const result = await sql`
    SELECT review_count, rating_average, computed_at
    FROM reviews.product_rating WHERE product_id = ${productId}
  `.execute(db);
  return result.rows[0] as ProductRatingRow;
}

describe('rebuildProductRating (TASK-0002, SPEC-0004, ADR-0014)', () => {
  let infra: ReviewsTestInfra;

  beforeAll(async () => {
    infra = await startReviewsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  // Mutation: in `src/internal/recompute-statement.ts`'s `applyRatingRecompute`, drop
  // `computed_at = excluded.computed_at` from the `ON CONFLICT DO UPDATE` SET list — the second
  // run's `computed_at` stays pinned at the first run's value and the strictly-increased
  // assertion below goes red.
  it('running rebuildProductRating twice is idempotent: every column but computed_at is identical, and computed_at strictly increases', async () => {
    const product = await createTestProduct(infra.db);
    const authorA = await createAppUser(infra.db);
    const authorB = await createAppUser(infra.db);
    await submitReview(infra.db, {
      productSlug: product.slug,
      authorId: authorA,
      rating: 5,
      title: 'Excellent product overall',
      body: 'Works perfectly and arrived right on time as promised.',
    });
    await submitReview(infra.db, {
      productSlug: product.slug,
      authorId: authorB,
      rating: 3,
      title: 'It is fine, I suppose',
      body: 'Does the job but nothing about it stands out at all.',
    });

    const first = await rebuildProductRating(infra.db, { productSlug: product.slug });
    expect(first.productsRecomputed).toBe(1);
    const firstRow = await fetchProductRating(infra.db, product.productId);
    expect(firstRow.review_count).toBe(2);
    expect(firstRow.rating_average).toBe('4.00');

    await new Promise((resolve) => setTimeout(resolve, 5));

    const second = await rebuildProductRating(infra.db, { productSlug: product.slug });
    expect(second.productsRecomputed).toBe(1);
    const secondRow = await fetchProductRating(infra.db, product.productId);

    expect(secondRow.review_count).toBe(firstRow.review_count);
    expect(secondRow.rating_average).toBe(firstRow.rating_average);
    expect(secondRow.computed_at.getTime()).toBeGreaterThan(firstRow.computed_at.getTime());
  });

  // The drop-and-rebuild proof (TASK-0002's own words): drop `reviews.product_rating` entirely,
  // rebuild it, and compare against an INDEPENDENT aggregate computed directly from
  // `reviews.review` — never against the module's own recompute statement, which would only prove
  // the code agrees with itself.
  //
  // `CREATE TABLE ... (LIKE reviews.product_rating INCLUDING ALL)` copies defaults, `CHECK`
  // constraints and indexes (the primary key included) but Postgres's `LIKE` clause NEVER copies
  // foreign keys, `INCLUDING ALL` or not — so the rebuilt table has no
  // `fk_product_rating__product` afterwards. This test does not prove that foreign key survives a
  // drop/rebuild cycle; it proves only that the AGGREGATE VALUES are reconstructed correctly.
  //
  // Mutation: in `src/internal/recompute-statement.ts`'s `applyRatingRecompute`, change
  // `WHERE product_id = ${productId} AND review_moderation_state_id = ${REVIEW_MODERATION_STATE.Published.id}`
  // to drop the moderation-state filter — the rebuilt table's counts would include rejected
  // reviews while the independent aggregate below still filters them out, and the comparison
  // goes red.
  it('drops reviews.product_rating entirely, rebuilds it, and matches an independent aggregate computed from reviews.review directly', async () => {
    const productOne = await createTestProduct(infra.db);
    const productTwo = await createTestProduct(infra.db);
    const authorA = await createAppUser(infra.db);
    const authorB = await createAppUser(infra.db);
    const authorC = await createAppUser(infra.db);

    await submitReview(infra.db, {
      productSlug: productOne.slug,
      authorId: authorA,
      rating: 4,
      title: 'Pretty happy with this',
      body: 'A reliable everyday product that does what it promises.',
    });
    await submitReview(infra.db, {
      productSlug: productOne.slug,
      authorId: authorB,
      rating: 2,
      title: 'Not quite what I wanted',
      body: 'It works but the build quality feels cheaper than expected.',
    });
    await submitReview(infra.db, {
      productSlug: productTwo.slug,
      authorId: authorC,
      rating: 5,
      title: 'Perfect for my needs',
      body: 'Exactly what I was looking for, no complaints whatsoever.',
    });

    await sql`CREATE TABLE reviews.product_rating_rebuild (LIKE reviews.product_rating INCLUDING ALL)`.execute(
      infra.db,
    );
    await sql`DROP TABLE reviews.product_rating`.execute(infra.db);
    await sql`ALTER TABLE reviews.product_rating_rebuild RENAME TO product_rating`.execute(
      infra.db,
    );

    const report = await rebuildProductRating(infra.db);
    expect(report.productsRecomputed).toBeGreaterThanOrEqual(2);

    const independent = await sql`
      SELECT product_id, count(*)::int AS review_count, round(avg(rating), 2) AS rating_average
      FROM reviews.review
      WHERE review_moderation_state_id = ${REVIEW_MODERATION_STATE.Published.id}
      GROUP BY product_id
    `.execute(infra.db);
    const rebuilt = await sql`
      SELECT product_id, review_count, rating_average FROM reviews.product_rating
    `.execute(infra.db);

    type Aggregate = { readonly review_count: number; readonly rating_average: string | null };
    const toMap = (rows: ReadonlyArray<unknown>): Map<string, Aggregate> =>
      new Map(
        (
          rows as ReadonlyArray<{
            product_id: string;
            review_count: number;
            rating_average: string | null;
          }>
        ).map((row) => [
          row.product_id,
          { review_count: row.review_count, rating_average: row.rating_average },
        ]),
      );

    expect(toMap(rebuilt.rows)).toStrictEqual(toMap(independent.rows));
  });

  // Mutation: in `src/rating.ts`'s `rebuildProductRating`, drop the
  // `if (options.productSlug !== undefined)` early return so a scoped call always falls through
  // to the unscoped DISTINCT scan — `productTwo`'s `computed_at` (and every other product's) would
  // move even though only `productOne`'s rebuild was requested, and `stillTwo` no longer
  // strictly-equals `baselineTwo`.
  it('a scoped rebuildProductRating({ productSlug }) recomputes only that product', async () => {
    const productOne = await createTestProduct(infra.db);
    const productTwo = await createTestProduct(infra.db);
    const authorA = await createAppUser(infra.db);
    const authorB = await createAppUser(infra.db);
    await submitReview(infra.db, {
      productSlug: productOne.slug,
      authorId: authorA,
      rating: 5,
      title: 'Great for what I needed',
      body: 'Product one performed above expectations for weeks now.',
    });
    await submitReview(infra.db, {
      productSlug: productTwo.slug,
      authorId: authorB,
      rating: 2,
      title: 'Not great for my use case',
      body: 'Product two broke down within the first week of use.',
    });

    // Baseline product two's row first, so "untouched" is checkable against something concrete —
    // including its computed_at, the strongest possible proof nothing about it moved.
    await rebuildProductRating(infra.db, { productSlug: productTwo.slug });
    const baselineTwo = await fetchProductRating(infra.db, productTwo.productId);

    const report = await rebuildProductRating(infra.db, { productSlug: productOne.slug });
    expect(report.productsRecomputed).toBe(1);

    const afterOne = await fetchProductRating(infra.db, productOne.productId);
    expect(afterOne.review_count).toBe(1);
    expect(afterOne.rating_average).toBe('5.00');

    const stillTwo = await fetchProductRating(infra.db, productTwo.productId);
    expect(stillTwo).toStrictEqual(baselineTwo);
  });

  // Mutation: in `src/internal/recompute-statement.ts`'s `applyRatingRecompute`, drop
  // `AND review_moderation_state_id = ${REVIEW_MODERATION_STATE.Published.id}` from the `WHERE`
  // clause — `review_count` becomes 2 and `rating_average` becomes `'3.00'`, and this goes red.
  it('a rejected review does not count toward review_count or rating_average', async () => {
    const product = await createTestProduct(infra.db);
    const authorPublished = await createAppUser(infra.db);
    const authorRejected = await createAppUser(infra.db);

    await submitReview(infra.db, {
      productSlug: product.slug,
      authorId: authorPublished,
      rating: 5,
      title: 'Loved this one a lot',
      body: 'Consistently reliable and well worth the asking price.',
    });
    const rejected = await submitReview(infra.db, {
      productSlug: product.slug,
      authorId: authorRejected,
      rating: 1,
      title: 'This is spam content',
      body: 'Not a real review, just filler text meant to pass checks.',
    });

    // Simulate a moderator's reject transition directly — the same plain `UPDATE` SPEC-0002
    // describes (TASK-0009's own write path is out of scope for this package).
    await sql`
      UPDATE reviews.review SET review_moderation_state_id = ${REVIEW_MODERATION_STATE.Rejected.id}
      WHERE token = ${rejected.review.token}
    `.execute(infra.db);

    await rebuildProductRating(infra.db, { productSlug: product.slug });
    const row = await fetchProductRating(infra.db, product.productId);
    expect(row.review_count).toBe(1);
    expect(row.rating_average).toBe('5.00');
  });

  // Mutation: in `src/internal/recompute-statement.ts`'s `applyRatingRecompute`, add
  // `WHERE excluded.review_count > 0` to the `ON CONFLICT ... DO UPDATE` clause (i.e. skip the
  // update when the fresh count is zero) — a recompute is supposed to be exactly that, never a
  // delta (ADR-0014), and this mutation turns it back into one: `after.review_count` stays at its
  // stale `1` instead of dropping to `0`, and this goes red.
  it('a product whose reviews were all deleted recomputes to (0, NULL)', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    await submitReview(infra.db, {
      productSlug: product.slug,
      authorId,
      rating: 4,
      title: 'Decent but unremarkable',
      body: 'Nothing special here, does what it says on the box.',
    });

    await rebuildProductRating(infra.db, { productSlug: product.slug });
    const before = await fetchProductRating(infra.db, product.productId);
    expect(before.review_count).toBe(1);

    await sql`DELETE FROM reviews.review WHERE product_id = ${product.productId}`.execute(infra.db);

    await rebuildProductRating(infra.db, { productSlug: product.slug });
    const after = await fetchProductRating(infra.db, product.productId);
    expect(after.review_count).toBe(0);
    expect(after.rating_average).toBeNull();
  });
});
