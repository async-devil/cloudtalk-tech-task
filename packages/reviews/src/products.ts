import { PRODUCT_CATEGORY, type ProductCategoryName } from '@repo/entities';
import { NotFoundError, ValidationError } from '@repo/kernel';
import { rowAs, rowsAs } from '@repo/persistence';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from './internal/cursor.js';
import { obs } from './internal/observability.js';
import { productUpdateBindsFor, type UpdateProductInput } from './internal/product-update-input.js';
import { productCategoryIdFor, productCategoryNameFor } from './internal/reference-ids.js';
import {
  productDetailRowSchema,
  productRowSchema,
  productSummaryRowSchema,
} from './internal/rows.js';
import { translateUniqueViolation } from './internal/unique-violation.js';

export type { UpdateProductInput };

/** `createProduct`'s input (SPEC-0002/SPEC-0003). Every field is required — a product is created
 * whole, never in stages. */
export interface CreateProductInput {
  readonly slug: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly categoryName: ProductCategoryName;
  readonly priceMinor: number;
  readonly currencyCode: string;
}

/** The catalogue's public product shape. No `product_id` (ADR-0016: no internal uuid crosses this
 * module's public contract) — `slug` is the address every caller already has. */
export interface ProductRecord {
  readonly slug: string;
  readonly sku: string;
  readonly name: string;
  readonly description: string;
  readonly categoryName: ProductCategoryName;
  readonly priceMinor: number;
  readonly currencyCode: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

type ProductRow = z.infer<typeof productRowSchema>;

function toProductRecord(row: ProductRow): ProductRecord {
  return {
    slug: row.slug,
    sku: row.sku,
    name: row.name,
    description: row.description,
    categoryName: productCategoryNameFor(row.product_category_id),
    priceMinor: row.price_minor,
    currencyCode: row.currency_code,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Plain `INSERT ... RETURNING`. No advisory lock: there is no read-then-write window to protect —
 * a `slug`/`sku` collision is caught by its unique constraint, never raced against a prior read.
 * `product_category_id` is resolved through the compile-time `productCategoryIdFor` constant
 * rather than a join on `reference.product_category.name`; the foreign key is the backstop.
 *
 * Emits NO outbox row and creates NO `reviews.product_rating` row (SPEC-0004): creating a product
 * has no review to aggregate, so no recomputation is owed, and a zero-row projection insert would
 * claim a `computed_at` for a computation that never ran.
 */
export function createProduct(
  db: Kysely<unknown>,
  input: CreateProductInput,
): Promise<ProductRecord> {
  return obs.withSpan('reviews.product.create', async () => {
    try {
      const result = await sql`
        INSERT INTO reviews.product
          (slug, sku, name, description, product_category_id, price_minor, currency_code)
        VALUES (
          ${input.slug}, ${input.sku}, ${input.name}, ${input.description},
          ${productCategoryIdFor(input.categoryName)}, ${input.priceMinor}, ${input.currencyCode}
        )
        RETURNING slug, sku, name, description, product_category_id, price_minor, currency_code,
                  created_at, updated_at
      `.execute(db);
      return toProductRecord(rowAs(productRowSchema, result.rows[0]));
    } catch (error) {
      const violation = translateUniqueViolation(error);
      throw violation ?? error;
    }
  });
}

/**
 * `internal/product-update-input.ts` holds the guard AND is the single mutation target of this
 * function's statement: `slug` and `sku` are absent from the `SET` list on purpose (SPEC-0002's
 * immutability rule, the second half of the guard), and every mutable column is
 * `COALESCE($n, column)` against one of `productUpdateBindsFor`'s five explicit `T | null` binds.
 * No unique-violation translation needed here — an immutable column can never be the one that
 * collides on this statement.
 */
export function updateProduct(
  db: Kysely<unknown>,
  input: UpdateProductInput,
): Promise<ProductRecord> {
  return obs.withSpan('reviews.product.update', async () => {
    const binds = productUpdateBindsFor(input);
    const result = await sql`
      UPDATE reviews.product
      SET name                = COALESCE(${binds.name}, name),
          description         = COALESCE(${binds.description}, description),
          product_category_id = COALESCE(${binds.productCategoryId}, product_category_id),
          price_minor         = COALESCE(${binds.priceMinor}, price_minor),
          currency_code       = COALESCE(${binds.currencyCode}, currency_code)
      WHERE slug = ${input.productSlug}
      RETURNING slug, sku, name, description, product_category_id, price_minor, currency_code,
                created_at, updated_at
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) {
      throw new NotFoundError(`updateProduct: no product with slug "${input.productSlug}"`);
    }
    return toProductRecord(rowAs(productRowSchema, row));
  });
}

// ---------------------------------------------------------------------------------------------
// listProducts / getProductBySlug (TASK-0003, SPEC-0003) — the catalogue's two anonymous reads.
// Both read `reviews.product_rating` LEFT JOINed to `reviews.product`, the rating PROJECTION
// (ADR-0014), never the authoritative review rows: `reviews.listForProduct` is the one route on
// this module's contract that reads `reviews.review` directly, and it lives in `reviews.ts` for
// exactly that reason. That split is the whole point of the projection and is visible here in
// which table each function's `FROM`/`JOIN` names, with no comment required to say so.
// ---------------------------------------------------------------------------------------------

/** A product's rating aggregate as this module hands it back (TASK-0003): `ratingAverage` stays
 * `string | null` — the same "never convert `numeric` here" rule `ProductRatingRecord` states —
 * and `computedAt` is `null` until the first recomputation ever runs for this product (no
 * `reviews.product_rating` row exists yet). Converting either to the wire's `number`/ISO-string
 * shape is the router's job (SPEC-0003's `ratingAggregateSchema` doc). */
export interface ProductRatingSummary {
  readonly reviewCount: number;
  readonly ratingAverage: string | null;
  readonly computedAt: Date | null;
}

/** The catalogue card / list-row shape (SPEC-0001 S2, SPEC-0003 `productSummary`). */
export interface ProductSummaryRecord {
  readonly slug: string;
  readonly sku: string;
  readonly name: string;
  readonly categoryName: ProductCategoryName;
  readonly priceMinor: number;
  readonly currencyCode: string;
  readonly rating: ProductRatingSummary;
}

/** `ProductSummaryRecord` plus the one field a catalogue card has no room for (SPEC-0001 S3's
 * header, SPEC-0003 `productDetail`). */
export interface ProductDetailRecord extends ProductSummaryRecord {
  readonly description: string;
}

type ProductSummaryRow = z.infer<typeof productSummaryRowSchema>;
type ProductDetailRow = z.infer<typeof productDetailRowSchema>;

function toProductSummaryRecord(row: ProductSummaryRow): ProductSummaryRecord {
  return {
    slug: row.slug,
    sku: row.sku,
    name: row.name,
    categoryName: productCategoryNameFor(row.product_category_id),
    priceMinor: row.price_minor,
    currencyCode: row.currency_code,
    rating: {
      reviewCount: row.review_count,
      ratingAverage: row.rating_average,
      computedAt: row.computed_at,
    },
  };
}

/**
 * `getProductBySlug`'s catalogue read (TASK-0003, SPEC-0003 `products.get`): unknown slug is
 * `NotFoundError`. Reads the projection — see this section's header note.
 * @throws NotFoundError when no product has this slug.
 */
export function getProductBySlug(
  db: Kysely<unknown>,
  productSlug: string,
): Promise<ProductDetailRecord> {
  return obs.withSpan('reviews.product.get', async () => {
    const result = await sql`
      SELECT p.slug, p.sku, p.name, p.description, p.product_category_id, p.price_minor,
             p.currency_code, p.created_at,
             COALESCE(pr.review_count, 0) AS review_count,
             pr.rating_average, pr.computed_at
      FROM reviews.product p
      LEFT JOIN reviews.product_rating pr ON pr.product_id = p.product_id
      WHERE p.slug = ${productSlug}
    `.execute(db);
    const row = result.rows[0];
    if (row === undefined) {
      throw new NotFoundError(`no product with slug "${productSlug}"`);
    }
    const parsed: ProductDetailRow = rowAs(productDetailRowSchema, row);
    return { ...toProductSummaryRecord(parsed), description: parsed.description };
  });
}

const PRODUCT_LIST_SORT = ['rating', 'recent', 'name'] as const;
export type ProductListSort = (typeof PRODUCT_LIST_SORT)[number];

export interface ListProductsInput {
  /** Case-insensitive substring match on product NAME OR SKU (SPEC-0003) — pasting a SKU finds
   * its product. */
  readonly query?: string;
  /** A category NAME, validated against the closed vocabulary the same way `createProduct` does
   * (`productCategoryIdFor`) — an unrecognised name is `ValidationError`, not a silent empty
   * result, matching this route's documented `VALIDATION` failure mode (SPEC-0003). */
  readonly category?: string;
  readonly sort: ProductListSort;
  readonly cursor?: string;
  readonly limit: number;
}

export interface ProductListPage {
  readonly items: readonly ProductSummaryRecord[];
  readonly nextCursor: string | null;
}

/**
 * The opaque cursor's decoded shape: `sort` pins it to the sort it was minted under — a cursor
 * from a different sort is rejected as `VALIDATION` (SPEC-0003 open question 5) — `k1`/`k2` are
 * the sort's own key columns (string-encoded so the payload stays plain JSON), and `slug` is the
 * deterministic tie-break every sort shares (a catalogue row's own public identifier, never an
 * internal uuid — ADR-0016).
 */
const productListCursorSchema = z.object({
  v: z.literal(1),
  sort: z.enum(PRODUCT_LIST_SORT),
  k1: z.string(),
  k2: z.string(),
  slug: z.string(),
});
type ProductListCursor = z.infer<typeof productListCursorSchema>;

/** `COALESCE(pr.rating_average, -1)` as a string — the same sentinel the `'rating'` sort's
 * `ORDER BY`/cursor-filter both use, so a never-reviewed product sorts after every rated one under
 * `DESC` without a `NULLS LAST` clause that a keyset `WHERE` cannot express symmetrically. */
function coalescedRatingAverage(row: ProductSummaryRow): string {
  return row.rating_average ?? '-1';
}

/** The `(k1, k2)` cursor key for `row` under `sort` — the exact pair the WHERE fragment below
 * compares against, computed from the SAME coalesced values the query itself sorts by. */
function productCursorKeyOf(
  sort: ProductListSort,
  row: ProductSummaryRow,
): { k1: string; k2: string } {
  switch (sort) {
    case 'rating':
      return { k1: coalescedRatingAverage(row), k2: String(row.review_count) };
    case 'recent':
      return { k1: row.created_at.toISOString(), k2: '' };
    case 'name':
      return { k1: row.name, k2: '' };
  }
}

/** `ORDER BY` for `sort` — SPEC-0003: `'rating'` orders by `rating_average DESC NULLS LAST` then
 * `review_count DESC` (unrated products last, SPEC-0001 open question 4); `'recent'`/`'name'` are
 * a single column. Every branch ends in `p.slug ASC`, the deterministic tie-break a keyset cursor
 * needs regardless of sort. */
function productOrderClause(sort: ProductListSort): RawBuilder<unknown> {
  switch (sort) {
    case 'rating':
      return sql`ORDER BY COALESCE(pr.rating_average, -1) DESC, COALESCE(pr.review_count, 0) DESC, p.slug ASC`;
    case 'recent':
      return sql`ORDER BY p.created_at DESC, p.slug ASC`;
    case 'name':
      return sql`ORDER BY p.name ASC, p.slug ASC`;
  }
}

/** The keyset `WHERE` fragment for resuming `sort` after `cursor` — an explicit OR-chain, not a
 * row-wise `(k1, k2, slug) < (...)` comparison, because the three columns do not all sort the same
 * direction (`DESC, DESC, ASC` for `'rating'`) and Postgres row comparison assumes one. Mirrors
 * {@link productOrderClause} column-for-column and direction-for-direction. */
function productCursorFilter(
  sort: ProductListSort,
  cursor: ProductListCursor,
): RawBuilder<unknown> {
  switch (sort) {
    case 'rating':
      return sql`(
        COALESCE(pr.rating_average, -1) < ${cursor.k1}::numeric
        OR (COALESCE(pr.rating_average, -1) = ${cursor.k1}::numeric
            AND COALESCE(pr.review_count, 0) < ${cursor.k2}::integer)
        OR (COALESCE(pr.rating_average, -1) = ${cursor.k1}::numeric
            AND COALESCE(pr.review_count, 0) = ${cursor.k2}::integer
            AND p.slug > ${cursor.slug})
      )`;
    case 'recent':
      return sql`(
        p.created_at < ${cursor.k1}::timestamptz
        OR (p.created_at = ${cursor.k1}::timestamptz AND p.slug > ${cursor.slug})
      )`;
    case 'name':
      return sql`(
        p.name > ${cursor.k1}
        OR (p.name = ${cursor.k1} AND p.slug > ${cursor.slug})
      )`;
  }
}

/** Narrows `input.category` — a plain wire `string`, not the closed `ProductCategoryName` union —
 * to the union `productCategoryIdFor` requires, WITHOUT a cast: an unrecognised name throws
 * `ValidationError({ field: 'category' })` here rather than reaching `productCategoryIdFor`'s own
 * throw, which names the field `categoryName` — the right field for `createProduct`'s input, the
 * wrong one for this route's `category` query parameter. */
function isProductCategoryName(value: string): value is ProductCategoryName {
  return Object.values(PRODUCT_CATEGORY).some((category) => category.name === value);
}

/**
 * `products.list`'s catalogue read (TASK-0003, SPEC-0003): keyset-paginated over the rating
 * PROJECTION (`reviews.product_rating` LEFT JOINed to `reviews.product` — a never-reviewed product
 * has no row there, ADR-0014). `input.limit` is trusted as already validated — the wire's `≤ 50`
 * ceiling is enforced by the contract's own Zod schema and rejected as `VALIDATION` before this
 * function is ever called (SPEC-0003), so nothing here caps it a second time.
 *
 * Fetches `limit + 1` rows and drops the extra one, the standard keyset "is there a next page"
 * test — cheaper than a second `COUNT`, and exact regardless of how the catalogue changes between
 * pages.
 */
export function listProducts(
  db: Kysely<unknown>,
  input: ListProductsInput,
): Promise<ProductListPage> {
  return obs.withSpan('reviews.product.list', async () => {
    const filters: RawBuilder<unknown>[] = [sql`1 = 1`];
    if (input.category !== undefined) {
      if (!isProductCategoryName(input.category)) {
        throw new ValidationError(`unknown product category "${input.category}"`, {
          details: { field: 'category' },
        });
      }
      filters.push(sql`p.product_category_id = ${productCategoryIdFor(input.category)}`);
    }
    if (input.query !== undefined && input.query.length > 0) {
      filters.push(
        sql`(position(lower(${input.query}) in lower(p.name)) > 0
             OR position(lower(${input.query}) in lower(p.sku)) > 0)`,
      );
    }
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(input.cursor, productListCursorSchema);
      if (cursor.sort !== input.sort) {
        throw new ValidationError('cursor does not match the current sort', {
          details: { field: 'cursor' },
        });
      }
      filters.push(productCursorFilter(input.sort, cursor));
    }

    const result = await sql`
      SELECT p.slug, p.sku, p.name, p.product_category_id, p.price_minor, p.currency_code,
             p.created_at,
             COALESCE(pr.review_count, 0) AS review_count,
             pr.rating_average, pr.computed_at
      FROM reviews.product p
      LEFT JOIN reviews.product_rating pr ON pr.product_id = p.product_id
      WHERE ${sql.join(filters, sql` AND `)}
      ${productOrderClause(input.sort)}
      LIMIT ${input.limit + 1}
    `.execute(db);
    const rows = rowsAs(productSummaryRowSchema, result.rows);

    const page = rows.slice(0, input.limit);
    const hasMore = rows.length > input.limit;
    const last = page[page.length - 1];
    const nextCursor: string | null =
      hasMore && last !== undefined
        ? encodeCursor({
            v: 1,
            sort: input.sort,
            ...productCursorKeyOf(input.sort, last),
            slug: last.slug,
          } satisfies ProductListCursor)
        : null;

    return { items: page.map(toProductSummaryRecord), nextCursor };
  });
}
