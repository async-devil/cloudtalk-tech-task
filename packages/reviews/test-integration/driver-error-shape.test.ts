import { mintToken, PRODUCT_CATEGORY, REVIEW_MODERATION_STATE, TOKEN_PREFIX } from '@repo/entities';
import { ConflictError } from '@repo/kernel';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { translateUniqueViolation } from '../src/internal/unique-violation.js';
import {
  createAppUser,
  createTestProduct,
  type ReviewsTestInfra,
  startReviewsTestInfra,
} from './harness/postgres-container.js';

/**
 * The unit suite (`test/unique-violation.test.ts`) proves `translateUniqueViolation` against a
 * FAKED driver error — a plain `Error` with `code`/`constraint` attached by hand, exactly the
 * duck-typed shape `asUniqueViolation` narrows. That proves the translation logic is right GIVEN
 * that shape; it cannot prove Postgres (or a future `pg` version) still reports `constraint` on a
 * real `23505` at all. This file forces a REAL unique violation on each of the three constraints
 * this module maps, by inserting duplicates directly, and feeds the REAL caught error through the
 * same `translateUniqueViolation` the unit tests fake — the one proof this module owns that the
 * unit suite structurally cannot write.
 *
 * Mutation (shared across all three tests below, named once): if a future `pg`/Postgres version
 * stops populating `.constraint` on a `23505` — the exact regression this file exists to catch —
 * `asUniqueViolation` reads `constraint: undefined`, `translateUniqueViolation` falls through to
 * the unmapped-constraint branch, and every `toBeInstanceOf(ConflictError)` below goes red while
 * the faked unit tests (which hand-attach `constraint` themselves) would stay green regardless.
 */
describe('driver-error-shape: a REAL pg 23505 on each mapped constraint translates exactly as the unit tests fake', () => {
  let infra: ReviewsTestInfra;

  beforeAll(async () => {
    infra = await startReviewsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
    try {
      await promise;
    } catch (error) {
      return error;
    }
    throw new Error('expected the statement to reject with a unique violation, but it resolved');
  }

  // Mutation: in `src/internal/unique-violation.ts`'s `CONFLICT_FIELD_BY_CONSTRAINT`, delete the
  // `uq_product__slug` entry — the REAL error below still carries `code: '23505'` and
  // `constraint: 'uq_product__slug'`, but `translateUniqueViolation` now falls to the
  // `InternalError` branch, and `toBeInstanceOf(ConflictError)` goes red.
  it('a real 23505 on uq_product__slug translates to ConflictError({ field: "slug" })', async () => {
    const product = await createTestProduct(infra.db);
    const rawError = await captureRejection(
      sql`
        INSERT INTO reviews.product (slug, sku, name, description, product_category_id, price_minor, currency_code)
        VALUES (
          ${product.slug}, ${`DUP-${crypto.randomUUID().replace(/-/g, '').slice(0, 8).toUpperCase()}`},
          'Duplicate slug product', 'x', ${PRODUCT_CATEGORY.Audio.id}, 100, 'USD'
        )
      `.execute(infra.db),
    );
    expect((rawError as { code?: string }).code).toBe('23505');

    const translated = translateUniqueViolation(rawError);
    expect(translated).toBeInstanceOf(ConflictError);
    expect((translated as ConflictError).details).toEqual({ field: 'slug' });
  });

  // Mutation: same map, delete the `uq_product__sku` entry instead.
  it('a real 23505 on uq_product__sku translates to ConflictError({ field: "sku" })', async () => {
    const product = await createTestProduct(infra.db);
    const rawError = await captureRejection(
      sql`
        INSERT INTO reviews.product (slug, sku, name, description, product_category_id, price_minor, currency_code)
        VALUES (
          ${`dup-slug-${crypto.randomUUID().replace(/-/g, '').slice(0, 8)}`}, ${product.sku},
          'Duplicate sku product', 'x', ${PRODUCT_CATEGORY.Audio.id}, 100, 'USD'
        )
      `.execute(infra.db),
    );
    expect((rawError as { code?: string }).code).toBe('23505');

    const translated = translateUniqueViolation(rawError);
    expect(translated).toBeInstanceOf(ConflictError);
    expect((translated as ConflictError).details).toEqual({ field: 'sku' });
  });

  // Mutation: same map, delete the `uq_review__product_id__author_id` entry instead.
  it('a real 23505 on uq_review__product_id__author_id translates to ConflictError({ field: "review" })', async () => {
    const product = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    await sql`
      INSERT INTO reviews.review (token, product_id, author_id, rating, title, body, review_moderation_state_id)
      VALUES (
        ${mintToken(TOKEN_PREFIX.Review)}, ${product.productId}, ${authorId}, 4,
        'First review on this product', 'A perfectly ordinary review body of sufficient length.',
        ${REVIEW_MODERATION_STATE.Published.id}
      )
    `.execute(infra.db);

    const rawError = await captureRejection(
      sql`
        INSERT INTO reviews.review (token, product_id, author_id, rating, title, body, review_moderation_state_id)
        VALUES (
          ${mintToken(TOKEN_PREFIX.Review)}, ${product.productId}, ${authorId}, 2,
          'Second review, same author', 'Another perfectly ordinary review body of length.',
          ${REVIEW_MODERATION_STATE.Published.id}
        )
      `.execute(infra.db),
    );
    expect((rawError as { code?: string }).code).toBe('23505');

    const translated = translateUniqueViolation(rawError);
    expect(translated).toBeInstanceOf(ConflictError);
    expect((translated as ConflictError).details).toEqual({ field: 'review' });
  });
});
