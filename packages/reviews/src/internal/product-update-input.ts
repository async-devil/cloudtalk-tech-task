import type { ProductCategoryName } from '@repo/entities';
import { ValidationError } from '@repo/kernel';
import { productCategoryIdFor } from './reference-ids.js';

/** The wire shape `updateProduct` accepts (SPEC-0003): every field but the address key is
 * optional — a caller supplies only what changed. `productSlug`, not `slug`, addresses the row,
 * precisely so the addressing field can never trip this file's own immutability guard. */
export interface UpdateProductInput {
  readonly productSlug: string;
  readonly name?: string;
  readonly description?: string;
  readonly categoryName?: ProductCategoryName;
  readonly priceMinor?: number;
  readonly currencyCode?: string;
}

/** The five `COALESCE($n, column)` binds `updateProduct`'s single `UPDATE` statement supplies.
 * Explicit `null`, never `undefined`: `COALESCE` needs `null` to mean "leave this column alone",
 * and a driver bind parameter of `undefined` is not the same thing. */
export interface ProductUpdateBinds {
  readonly name: string | null;
  readonly description: string | null;
  readonly productCategoryId: number | null;
  readonly priceMinor: number | null;
  readonly currencyCode: string | null;
}

/**
 * THE single mutation-guard rule for `reviews.product` (SPEC-0002: `slug`/`sku` are frozen at
 * creation, and neither immutability can be a `CHECK` — a constraint cannot see the old row). A
 * RUNTIME key check, not just the type: `input` crosses a wire boundary (TASK-0003's HTTP layer
 * parses a JSON body into this shape), and a JSON body still carries a `slug`/`sku` key at
 * runtime even though `UpdateProductInput`'s type declares neither.
 *
 * A second rule lives in the same function on purpose: no mutable field supplied is ALSO a
 * `ValidationError` — an empty patch would still fire `tg_product__set_updated_at` for a write
 * that changed nothing, and the trigger has no way to tell a no-op update from a real one.
 *
 * @throws ValidationError `details.field: 'slug'` or `'sku'` when either immutable key is present
 * at runtime, or `details.field: 'update'` when no mutable field is supplied.
 */
export function productUpdateBindsFor(input: UpdateProductInput): ProductUpdateBinds {
  if ('slug' in input) {
    throw new ValidationError('slug cannot be changed after creation', {
      details: { field: 'slug' },
    });
  }
  if ('sku' in input) {
    throw new ValidationError('sku cannot be changed after creation', {
      details: { field: 'sku' },
    });
  }

  const { name, description, categoryName, priceMinor, currencyCode } = input;
  if (
    name === undefined &&
    description === undefined &&
    categoryName === undefined &&
    priceMinor === undefined &&
    currencyCode === undefined
  ) {
    throw new ValidationError('updateProduct requires at least one field to change', {
      details: { field: 'update' },
    });
  }

  return {
    name: name ?? null,
    description: description ?? null,
    productCategoryId: categoryName !== undefined ? productCategoryIdFor(categoryName) : null,
    priceMinor: priceMinor ?? null,
    currencyCode: currencyCode ?? null,
  };
}
