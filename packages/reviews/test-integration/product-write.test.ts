import { PRODUCT_CATEGORY } from '@repo/entities';
import { ConflictError, NotFoundError, ValidationError } from '@repo/kernel';
import { type Kysely, sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProduct,
  deriveProductSlug,
  type UpdateProductInput,
  updateProduct,
} from '../src/index.js';
import {
  createTestProduct,
  type ReviewsTestInfra,
  startReviewsTestInfra,
} from './harness/postgres-container.js';

async function countOutboxRows(db: Kysely<unknown>): Promise<number> {
  const result = await sql`SELECT count(*)::int AS count FROM reviews.outbox`.execute(db);
  return (result.rows[0] as { count: number }).count;
}

async function countProductRatingRows(db: Kysely<unknown>, productId: string): Promise<number> {
  const result = await sql`
    SELECT count(*)::int AS count FROM reviews.product_rating WHERE product_id = ${productId}
  `.execute(db);
  return (result.rows[0] as { count: number }).count;
}

async function fetchProductRow(
  db: Kysely<unknown>,
  slug: string,
): Promise<Record<string, unknown>> {
  const result = await sql`SELECT * FROM reviews.product WHERE slug = ${slug}`.execute(db);
  return result.rows[0] as Record<string, unknown>;
}

describe('createProduct / updateProduct (TASK-0002, SPEC-0002, SPEC-0004)', () => {
  let infra: ReviewsTestInfra;

  beforeAll(async () => {
    infra = await startReviewsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  // Mutation: in `src/products.ts`'s `createProduct`, add an `insertOutboxRows(trx, ...)` call
  // (or a zero-row `INSERT INTO reviews.product_rating`) after the `INSERT ... RETURNING` —
  // SPEC-0004 says creating a product emits nothing, and both assertions below go red.
  it('creates zero outbox rows and zero product_rating rows (SPEC-0004: creation emits nothing)', async () => {
    const before = await countOutboxRows(infra.db);
    const product = await createTestProduct(infra.db);
    expect(await countOutboxRows(infra.db)).toBe(before);
    expect(await countProductRatingRows(infra.db, product.productId)).toBe(0);
  });

  // Mutation: in `src/internal/unique-violation.ts`'s `CONFLICT_FIELD_BY_CONSTRAINT`, delete the
  // `uq_product__slug` entry — the violation falls to the `InternalError` branch instead of
  // `ConflictError`, and this test's `toBeInstanceOf(ConflictError)` goes red.
  it('duplicate slug throws ConflictError({ field: "slug" })', async () => {
    const product = await createTestProduct(infra.db);

    let caught: unknown;
    try {
      await createTestProduct(infra.db, { slug: product.slug });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).details).toEqual({ field: 'slug' });
  });

  // Mutation: same map, delete the `uq_product__sku` entry instead — same failure shape, on sku.
  it('duplicate sku throws ConflictError({ field: "sku" })', async () => {
    const product = await createTestProduct(infra.db);

    let caught: unknown;
    try {
      await createTestProduct(infra.db, { sku: product.sku });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConflictError);
    expect((caught as ConflictError).details).toEqual({ field: 'sku' });
  });

  // Mutation: in `src/internal/product-update-input.ts`'s `productUpdateBindsFor`, move the
  // `'sku' in input` guard to run AFTER `updateProduct`'s `UPDATE` statement instead of before it
  // (i.e. validate post-write) — the row's `updated_at` (bumped by `tg_product__set_updated_at`)
  // would already have moved by the time `ValidationError` throws, and the byte-identical
  // assertion below goes red even though the thrown error type looks unchanged. This is
  // TASK-0002's own reasoning for why immutability "is worth exactly as much as the test that
  // proves it."
  it('updateProduct carrying sku throws ValidationError and leaves the stored row byte-identical, updated_at included', async () => {
    const product = await createTestProduct(infra.db);
    const before = await fetchProductRow(infra.db, product.slug);

    // A wire-shaped body built as a plain variable (never a literal argument), exactly like
    // `test/immutable-fields.test.ts`'s unit proof: TypeScript's excess-property check on object
    // literals would otherwise mask the very runtime-key case this guard exists for.
    const wireBody = {
      productSlug: product.slug,
      name: 'New name from the wire',
      sku: 'NEW-SKU-01',
    };

    let caught: unknown;
    try {
      await updateProduct(infra.db, wireBody);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).details).toEqual({ field: 'sku' });

    const after = await fetchProductRow(infra.db, product.slug);
    expect(after).toStrictEqual(before);
  });

  // Mutation: in `src/products.ts`'s `updateProduct`, add an `insertOutboxRows` call after the
  // `UPDATE` — updating a product's mutable fields does not change which reviews count toward its
  // aggregate (SPEC-0004), and the final assertion goes red.
  it('a mutable-field update changes those columns, moves updated_at, preserves slug/sku/created_at, and emits no outbox row', async () => {
    const product = await createTestProduct(infra.db);
    const before = await fetchProductRow(infra.db, product.slug);
    const outboxBefore = await countOutboxRows(infra.db);

    // Postgres `timestamptz` carries microsecond resolution; a short pause keeps the
    // strictly-greater assertion below honest against a same-tick `now()` on a fast host.
    await new Promise((resolve) => setTimeout(resolve, 5));

    const updated: UpdateProductInput = {
      productSlug: product.slug,
      name: 'An updated product name',
      priceMinor: 2599,
    };
    const result = await updateProduct(infra.db, updated);

    expect(result.name).toBe('An updated product name');
    expect(result.priceMinor).toBe(2599);
    expect(result.slug).toBe(product.slug);
    expect(result.sku).toBe(product.sku);
    expect(result.createdAt).toStrictEqual(before.created_at);
    expect(result.updatedAt.getTime()).toBeGreaterThan((before.updated_at as Date).getTime());

    expect(await countOutboxRows(infra.db)).toBe(outboxBefore);
  });

  // Mutation: in `src/products.ts`'s `updateProduct`, replace the `row === undefined` check with
  // a fallback that fabricates a record instead of throwing `NotFoundError` — this goes red.
  it('updateProduct with an unknown slug throws NotFoundError', async () => {
    await expect(
      updateProduct(infra.db, { productSlug: 'does-not-exist-anywhere', name: 'x' }),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  // Mutation: in `src/internal/product-update-input.ts`'s `productUpdateBindsFor`, move the
  // `'slug' in input` guard to run AFTER `updateProduct`'s `UPDATE` statement instead of before it
  // — same reasoning as the `sku` test above (TASK-0002), extended to `slug` (TASK-0008): the
  // byte-identical assertion is what proves the guard runs before any write, not merely that it
  // eventually throws.
  it('updateProduct carrying slug throws ValidationError and leaves the stored row byte-identical, updated_at included', async () => {
    const product = await createTestProduct(infra.db);
    const before = await fetchProductRow(infra.db, product.slug);

    const wireBody = {
      productSlug: product.slug,
      name: 'New name from the wire',
      slug: 'a-completely-different-slug',
    };

    let caught: unknown;
    try {
      await updateProduct(infra.db, wireBody);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).details).toEqual({ field: 'slug' });

    const after = await fetchProductRow(infra.db, product.slug);
    expect(after).toStrictEqual(before);
  });
});

describe('createProduct: server-side slug derivation (TASK-0008, SPEC-0003)', () => {
  let infra: ReviewsTestInfra;

  beforeAll(async () => {
    infra = await startReviewsTestInfra();
  }, 180_000);

  afterAll(async () => {
    await infra.stop();
  }, 60_000);

  function uniqueSuffix(): string {
    return crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  }

  // Mutation: in `src/products.ts`'s `createProduct`, change
  // `const slug = input.slug ?? deriveProductSlug(input.name);` to always call
  // `deriveProductSlug(input.name)` regardless of a supplied `slug` — this test would still pass
  // (derivation from name never runs a caller-visible check here), but the SIBLING "verbatim" test
  // below goes red, since the stored row's slug would then never match the caller-supplied value.
  // Asserted against the REAL persisted row, not just `createProduct`'s return value, so a
  // derivation that only LOOKS right in the returned record (but never made it into the `INSERT`)
  // would still be caught.
  it('derives the slug from name when omitted, and the real stored row carries that derivation', async () => {
    const tag = uniqueSuffix();
    const name = `Sony  WH-1000XM5!!  ${tag}`;
    const expectedSlug = deriveProductSlug(name);

    const product = await createProduct(infra.db, {
      sku: `TEST-DERIVE-${tag.toUpperCase()}`,
      name,
      description: 'A product created to prove server-side slug derivation.',
      categoryName: PRODUCT_CATEGORY.Audio.name,
      priceMinor: 1999,
      currencyCode: 'USD',
      // slug deliberately omitted
    });

    expect(product.slug).toBe(expectedSlug);
    const row = await fetchProductRow(infra.db, expectedSlug);
    expect(row.slug).toBe(expectedSlug);
  });

  // Mutation: in `src/products.ts`'s `createProduct`, change
  // `const slug = input.slug ?? deriveProductSlug(input.name);` to
  // `const slug = deriveProductSlug(input.name);` (drop the `input.slug ??` half) — a supplied
  // slug would be silently discarded in favour of a fresh derivation from `name`, and this test's
  // equality assertion goes red because the two never match here on purpose (the name derives to
  // something else entirely).
  it('uses a supplied slug verbatim, never re-deriving it from name', async () => {
    const tag = uniqueSuffix();
    const suppliedSlug = `custom-slug-${tag}`;

    const product = await createProduct(infra.db, {
      sku: `TEST-VERBATIM-${tag.toUpperCase()}`,
      name: `A Totally Unrelated Product Name ${tag}`,
      description: 'A product created to prove a supplied slug is used verbatim.',
      categoryName: PRODUCT_CATEGORY.Audio.name,
      priceMinor: 1999,
      currencyCode: 'USD',
      slug: suppliedSlug,
    });

    expect(product.slug).toBe(suppliedSlug);
    const row = await fetchProductRow(infra.db, suppliedSlug);
    expect(row.slug).toBe(suppliedSlug);
  });
});
