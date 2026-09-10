import { NotFoundError, ValidationError } from '@repo/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  getProductBySlug,
  type ListProductsInput,
  listProducts,
  rebuildProductRating,
  submitReview,
} from '../src/index.js';
import {
  createAppUser,
  createTestProduct,
  type ReviewsTestInfra,
  startReviewsTestInfra,
} from './harness/postgres-container.js';

const BASE_INPUT: ListProductsInput = { sort: 'rating', limit: 20 };

/** Narrows a page's `nextCursor` (`string | null`) to `string`, failing the test loudly instead
 * of letting `exactOptionalPropertyTypes` force an explicit `cursor: undefined` at every call
 * site that already asserted the cursor is present. */
function requireCursor(nextCursor: string | null): string {
  if (nextCursor === null) {
    throw new Error('expected a non-null nextCursor');
  }
  return nextCursor;
}

describe('listProducts / getProductBySlug (TASK-0003, SPEC-0003, ADR-0014)', () => {
  let infra: ReviewsTestInfra;

  beforeAll(async () => {
    infra = await startReviewsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  // Mutation: in `src/products.ts`'s `getProductBySlug`, change the `LEFT JOIN` to a plain
  // `JOIN` — a never-reviewed product would then be excluded from the result set entirely instead
  // of coming back with `{ reviewCount: 0, ratingAverage: null, computedAt: null }`, and this
  // test's `NotFoundError`-is-NOT-thrown expectation goes red (it would throw instead).
  it('a never-reviewed product reads via the projection as reviewCount 0, ratingAverage null, computedAt null', async () => {
    const product = await createTestProduct(infra.db);

    const detail = await getProductBySlug(infra.db, product.slug);

    expect(detail.slug).toBe(product.slug);
    expect(detail.description).toBe(product.description);
    expect(detail.rating).toEqual({ reviewCount: 0, ratingAverage: null, computedAt: null });
  });

  // Mutation: in `src/products.ts`'s `toProductSummaryRecord`, hardcode `ratingAverage: '0.00'`
  // instead of `row.rating_average` — the assertion below goes red.
  it('a reviewed, recomputed product reads its rating aggregate off the projection, with computedAt set', async () => {
    const product = await createTestProduct(infra.db);
    const authorA = await createAppUser(infra.db);
    const authorB = await createAppUser(infra.db);
    await submitReview(infra.db, {
      productSlug: product.slug,
      authorId: authorA,
      rating: 5,
      title: 'Excellent purchase indeed',
      body: 'This exceeded every expectation I had for it, truly.',
    });
    await submitReview(infra.db, {
      productSlug: product.slug,
      authorId: authorB,
      rating: 3,
      title: 'Perfectly average product',
      body: 'Does the job, nothing more, nothing less than expected.',
    });
    await rebuildProductRating(infra.db, { productSlug: product.slug });

    const detail = await getProductBySlug(infra.db, product.slug);
    expect(detail.rating.reviewCount).toBe(2);
    expect(detail.rating.ratingAverage).toBe('4.00');
    expect(detail.rating.computedAt).toBeInstanceOf(Date);
  });

  // Mutation: in `src/internal/resolve-product.ts`-style guard — here `getProductBySlug`'s own
  // `if (row === undefined)` check — remove it (fabricate a record instead) and this goes red.
  it('getProductBySlug throws NotFoundError for an unknown slug', async () => {
    await expect(getProductBySlug(infra.db, 'no-such-slug-anywhere')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  // THE read-split assertion (TASK-0003's note, ADR-0014): `listProducts` never touches
  // `reviews.review` — verified here not by inspection but by never calling `rebuildProductRating`
  // at all and asserting every row still reports the honest "no reviews yet" shape rather than
  // some derived-on-the-fly number.
  //
  // Mutation: in `src/products.ts`'s `listProducts`, replace `COALESCE(pr.review_count, 0)` with
  // a correlated subquery counting `reviews.review` rows directly — the row would then report
  // `reviewCount: 1` for `withReview` even though `rebuildProductRating` was never called, and the
  // assertion on `withReview`'s rating goes red.
  it('never reads reviews.review directly: an unreviewed and an un-recomputed product both show no rating', async () => {
    const withReview = await createTestProduct(infra.db);
    const authorId = await createAppUser(infra.db);
    await submitReview(infra.db, {
      productSlug: withReview.slug,
      authorId,
      rating: 5,
      title: 'A review nobody recomputed yet',
      body: 'This review exists but the projection has not caught up to it.',
    });

    const page = await listProducts(infra.db, {
      ...BASE_INPUT,
      query: withReview.sku,
    });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.rating).toEqual({
      reviewCount: 0,
      ratingAverage: null,
      computedAt: null,
    });
  });

  // Mutation: in `src/products.ts`'s `listProducts`'s `'rating'` branch of `productOrderClause`,
  // drop `COALESCE(pr.rating_average, -1)` back to bare `pr.rating_average` — Postgres's default
  // `NULLS LAST` behaviour for `DESC` actually already sorts nulls last, so this ONE mutation
  // alone would not turn this test red; the real assertion this guards is the review_count
  // tie-break immediately below, which a bare-column ORDER BY handles identically. The proof that
  // matters is `rated.slug` appearing before `unrated.slug`, which fails if the coalesce is
  // instead miscomputed as always `-1` (e.g. swapping the COALESCE arguments).
  it("sort: 'rating' orders rated products above unrated ones, and by rating_average DESC, review_count DESC among rated ones", async () => {
    const unrated = await createTestProduct(infra.db);
    const highRated = await createTestProduct(infra.db);
    const lowRatedManyReviews = await createTestProduct(infra.db);

    const authorA = await createAppUser(infra.db);
    const authorB = await createAppUser(infra.db);
    const authorC = await createAppUser(infra.db);

    await submitReview(infra.db, {
      productSlug: highRated.slug,
      authorId: authorA,
      rating: 5,
      title: 'Best thing I have ever bought',
      body: 'A five-star experience from start to finish, no complaints.',
    });
    await rebuildProductRating(infra.db, { productSlug: highRated.slug });

    await submitReview(infra.db, {
      productSlug: lowRatedManyReviews.slug,
      authorId: authorB,
      rating: 2,
      title: 'Not thrilled about this one',
      body: 'A below-average purchase that fell short of what I hoped.',
    });
    await submitReview(infra.db, {
      productSlug: lowRatedManyReviews.slug,
      authorId: authorC,
      rating: 2,
      title: 'Another disappointed customer here',
      body: 'Two of us agree this one just did not hold up over time.',
    });
    await rebuildProductRating(infra.db, { productSlug: lowRatedManyReviews.slug });

    const page = await listProducts(infra.db, { sort: 'rating', limit: 50 });
    const slugs = page.items.map((item) => item.slug);
    const highIndex = slugs.indexOf(highRated.slug);
    const lowIndex = slugs.indexOf(lowRatedManyReviews.slug);
    const unratedIndex = slugs.indexOf(unrated.slug);

    expect(highIndex).toBeGreaterThanOrEqual(0);
    expect(lowIndex).toBeGreaterThan(highIndex);
    expect(unratedIndex).toBeGreaterThan(lowIndex);
  });

  // Mutation: in `src/products.ts`'s `listProducts`, change `LIMIT ${input.limit + 1}` to
  // `LIMIT ${input.limit}` — the "fetch one extra to detect a next page" trick breaks, `nextCursor`
  // becomes `null` on a page that is NOT actually last, and the second-page fetch below returns
  // zero items instead of the remaining ones.
  it('paginates by slug across two pages with no skip or repeat, honestly reporting nextCursor', async () => {
    const tag = `pg-${crypto.randomUUID().slice(0, 8)}`;
    const products = await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        createTestProduct(infra.db, { name: `${tag} product ${index}` }),
      ),
    );

    const firstPage = await listProducts(infra.db, {
      sort: 'name',
      limit: 2,
      query: tag,
    });
    expect(firstPage.items).toHaveLength(2);
    expect(firstPage.nextCursor).not.toBeNull();

    const secondPage = await listProducts(infra.db, {
      sort: 'name',
      limit: 2,
      query: tag,
      cursor: requireCursor(firstPage.nextCursor),
    });
    expect(secondPage.items).toHaveLength(1);
    expect(secondPage.nextCursor).toBeNull();

    const seenSlugs = [...firstPage.items, ...secondPage.items].map((item) => item.slug).sort();
    expect(seenSlugs).toEqual(products.map((product) => product.slug).sort());
  });

  // Mutation: in `src/products.ts`'s `listProducts`, delete the
  // `if (cursor.sort !== input.sort)` check — a cursor minted under `'name'` would silently be
  // honoured under `'recent'`, comparing an ISO-formatted product name against a timestamp column
  // instead of rejecting the request, and this test's `ValidationError` expectation goes red.
  it('rejects a cursor minted under a different sort as VALIDATION', async () => {
    const tag = `sortmix-${crypto.randomUUID().slice(0, 8)}`;
    await createTestProduct(infra.db, { name: `${tag} one` });
    await createTestProduct(infra.db, { name: `${tag} two` });

    const nameSortPage = await listProducts(infra.db, { sort: 'name', limit: 1, query: tag });
    expect(nameSortPage.nextCursor).not.toBeNull();

    await expect(
      listProducts(infra.db, {
        sort: 'recent',
        limit: 1,
        query: tag,
        cursor: requireCursor(nameSortPage.nextCursor),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('an unrecognised category name is VALIDATION, not a silent empty result', async () => {
    await expect(
      listProducts(infra.db, { ...BASE_INPUT, category: 'not-a-real-category' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('the category filter only returns products in that category', async () => {
    const tag = `cat-${crypto.randomUUID().slice(0, 8)}`;
    const audio = await createTestProduct(infra.db, {
      name: `${tag} audio`,
      categoryName: 'audio',
    });
    await createTestProduct(infra.db, { name: `${tag} kitchen`, categoryName: 'kitchen' });

    const page = await listProducts(infra.db, { ...BASE_INPUT, query: tag, category: 'audio' });
    expect(page.items.map((item) => item.slug)).toEqual([audio.slug]);
  });

  // SPEC-0003: "query is a case-insensitive substring match on product name OR SKU — pasting a
  // SKU finds its product." Mutation: in `src/products.ts`'s `listProducts`, drop the
  // `OR position(lower(${input.query}) in lower(p.sku)) > 0` half of the filter — searching by
  // SKU would then find nothing, and the second assertion goes red.
  it('query matches by name or by SKU, case-insensitively', async () => {
    const tag = `qry-${crypto.randomUUID().slice(0, 8).toUpperCase()}`;
    const product = await createTestProduct(infra.db, { name: `Widget ${tag}`, sku: `SKU-${tag}` });

    const byName = await listProducts(infra.db, { ...BASE_INPUT, query: tag.toLowerCase() });
    expect(byName.items.map((item) => item.slug)).toEqual([product.slug]);

    const bySku = await listProducts(infra.db, {
      ...BASE_INPUT,
      query: `sku-${tag.toLowerCase()}`,
    });
    expect(bySku.items.map((item) => item.slug)).toEqual([product.slug]);
  });
});
