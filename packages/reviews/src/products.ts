import type { ProductCategoryName } from '@repo/entities';
import { NotFoundError } from '@repo/kernel';
import { rowAs } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import type { z } from 'zod';
import { obs } from './internal/observability.js';
import { productUpdateBindsFor, type UpdateProductInput } from './internal/product-update-input.js';
import { productCategoryIdFor, productCategoryNameFor } from './internal/reference-ids.js';
import { productRowSchema } from './internal/rows.js';
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
