import { mintToken, PRODUCT_CATEGORY, REVIEW_MODERATION_STATE, TOKEN_PREFIX } from '@repo/entities';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createAppUser,
  createTestProduct,
  type ReviewsTestInfra,
  startReviewsTestInfra,
} from './harness/postgres-container.js';

/** Postgres's `check_violation` SQLSTATE — every assertion below forces one directly, bypassing
 * this package's write pipeline entirely (raw `INSERT`s against `infra.db`), per TASK-0002's
 * Notes: "the 1-5 rule lives at the database level as well as in the schema." */
const CHECK_VIOLATION = '23514';

interface RawReviewOverrides {
  readonly rating?: number;
  readonly title?: string;
  readonly body?: string;
}

/** Inserts directly into `reviews.review`, never through `submitReview` — the guard this file
 * proves is the `CHECK` constraint itself, independent of anything the pipeline validates first. */
function insertRawReview(
  db: Kysely<unknown>,
  productId: string,
  authorId: string,
  overrides: RawReviewOverrides = {},
): Promise<unknown> {
  return sql`
    INSERT INTO reviews.review (token, product_id, author_id, rating, title, body, review_moderation_state_id)
    VALUES (
      ${mintToken(TOKEN_PREFIX.Review)}, ${productId}, ${authorId},
      ${overrides.rating ?? 5}, ${overrides.title ?? 'A perfectly valid title'},
      ${overrides.body ?? 'A perfectly ordinary review body of sufficient length.'},
      ${REVIEW_MODERATION_STATE.Published.id}
    )
  `.execute(db);
}

describe('constraint-guards: the DDL holds against raw inserts that bypass the pipeline (TASK-0002 Notes)', () => {
  let infra: ReviewsTestInfra;

  beforeAll(async () => {
    infra = await startReviewsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  describe('reviews.review', () => {
    // Mutation: in `packages/persistence/migrations/0004-create-reviews.ts`, widen
    // `ck_review__rating_range` from `BETWEEN 1 AND 5` to `BETWEEN 0 AND 5` — this insert then
    // succeeds and the assertion goes red.
    it('rejects rating = 0', async () => {
      const product = await createTestProduct(infra.db);
      const authorId = await createAppUser(infra.db);
      await expect(
        insertRawReview(infra.db, product.productId, authorId, { rating: 0 }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    // Mutation: widen `ck_review__rating_range` to `BETWEEN 1 AND 6` — this insert then succeeds.
    it('rejects rating = 6', async () => {
      const product = await createTestProduct(infra.db);
      const authorId = await createAppUser(infra.db);
      await expect(
        insertRawReview(infra.db, product.productId, authorId, { rating: 6 }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    // Mutation: loosen `ck_review__title_length` from `BETWEEN 3 AND 120` to
    // `BETWEEN 1 AND 120` — a 2-character title then succeeds.
    it('rejects a 2-character title', async () => {
      const product = await createTestProduct(infra.db);
      const authorId = await createAppUser(infra.db);
      await expect(
        insertRawReview(infra.db, product.productId, authorId, { title: 'Hi' }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    // Mutation: loosen `ck_review__body_length` from `BETWEEN 10 AND 4000` to
    // `BETWEEN 1 AND 4000` — a 9-character body then succeeds.
    it('rejects a 9-character body', async () => {
      const product = await createTestProduct(infra.db);
      const authorId = await createAppUser(infra.db);
      await expect(
        insertRawReview(infra.db, product.productId, authorId, { body: 'too short' }),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  describe('reviews.product_rating', () => {
    // Mutation: drop `ck_product_rating__average_present_when_reviewed` from
    // `0004-create-reviews.ts` — a `(review_count=0, rating_average=4.5)` row then inserts
    // cleanly and this assertion goes red.
    it('rejects (review_count = 0, rating_average = 4.5)', async () => {
      const product = await createTestProduct(infra.db);
      await expect(
        sql`
          INSERT INTO reviews.product_rating (product_id, review_count, rating_average)
          VALUES (${product.productId}, 0, 4.5)
        `.execute(infra.db),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    // Mutation: same constraint drop as above — a `(review_count=3, rating_average=NULL)` row
    // then inserts cleanly and this assertion goes red.
    it('rejects (review_count = 3, rating_average = NULL)', async () => {
      const product = await createTestProduct(infra.db);
      await expect(
        sql`
          INSERT INTO reviews.product_rating (product_id, review_count, rating_average)
          VALUES (${product.productId}, 3, NULL)
        `.execute(infra.db),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  describe('reviews.product', () => {
    // Mutation: loosen `ck_product__slug_format`'s pattern to also admit uppercase and
    // underscores (e.g. `'^[A-Za-z0-9_]+(-[A-Za-z0-9_]+)*$'`) — this malformed slug then succeeds
    // and this assertion goes red.
    it('rejects a malformed slug', async () => {
      await expect(
        sql`
          INSERT INTO reviews.product (slug, sku, name, description, product_category_id, price_minor, currency_code)
          VALUES ('Not_A_Valid_Slug!', 'VALID-SKU-01', 'x', 'x', ${PRODUCT_CATEGORY.Audio.id}, 100, 'USD')
        `.execute(infra.db),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    // Mutation: loosen `ck_product__sku_format`'s pattern to also admit lowercase — this
    // malformed sku then succeeds and this assertion goes red.
    it('rejects a malformed sku', async () => {
      await expect(
        sql`
          INSERT INTO reviews.product (slug, sku, name, description, product_category_id, price_minor, currency_code)
          VALUES ('a-valid-slug-01', 'not-a-valid-sku', 'x', 'x', ${PRODUCT_CATEGORY.Audio.id}, 100, 'USD')
        `.execute(infra.db),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });
});
