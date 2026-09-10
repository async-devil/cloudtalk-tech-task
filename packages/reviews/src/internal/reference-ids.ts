import {
  PRODUCT_CATEGORY,
  type ProductCategoryId,
  type ProductCategoryName,
  REVIEW_MODERATION_STATE,
  type ReviewModerationStateName,
} from '@repo/entities';
import { InternalError, ValidationError } from '@repo/kernel';

// One kind of declaration: every export below is a lookup over one of this module's two closed
// reference vocabularies (`reference.product_category`, `reference.review_moderation_state`),
// built once from the `{ id, name }` const objects in `@repo/entities` — never a join. The forward
// direction (name -> id) is a compile-time constant `createProduct`/`updateProduct` use to avoid a
// round trip to `reference.product_category`; the table's own foreign key is the backstop if this
// ever disagreed with the seeded rows, and `test-integration/reference-parity.test.ts` (SPEC-0002)
// is what keeps the two one thing. The reverse direction (id -> name) reads a row this module's
// own INSERT/UPDATE/SELECT just returned, so a miss there is schema drift, never a caller's fault.

// Keyed by plain `string`, not `ProductCategoryName`: {@link productCategoryIdFor} is itself the
// narrow-or-throw boundary for a wire-sourced category name (TASK-0008's `products.create`/
// `products.update`, alongside `listProducts`'s pre-narrowed `isProductCategoryName` call) — a
// `Map<ProductCategoryName, _>` would force every caller to already hold the narrow type before
// calling the very function that validates it.
const PRODUCT_CATEGORY_ID_BY_NAME = new Map<string, ProductCategoryId>(
  Object.values(PRODUCT_CATEGORY).map((category) => [category.name, category.id]),
);
const PRODUCT_CATEGORY_NAME_BY_ID = new Map<number, ProductCategoryName>(
  Object.values(PRODUCT_CATEGORY).map((category) => [category.id, category.name]),
);
const REVIEW_MODERATION_STATE_NAME_BY_ID = new Map<number, ReviewModerationStateName>(
  Object.values(REVIEW_MODERATION_STATE).map((state) => [state.id, state.name]),
);

/**
 * `categoryName -> product_category_id`, from the compile-time `PRODUCT_CATEGORY` vocabulary —
 * never a join on `reference.product_category.name`. `createProduct`/`updateProduct`'s write path
 * needs no round trip to resolve it; `fk_product__product_category` is the backstop if this ever
 * disagreed with the seeded rows.
 *
 * Typed `categoryName: string`, not `ProductCategoryName`, ON PURPOSE (TASK-0008): this function
 * IS the parse boundary between an arbitrary wire-sourced string and the closed vocabulary — a
 * narrower parameter type would force every caller to already hold a `ProductCategoryName` before
 * calling the one function that proves a value is one, which is backwards for a boundary check.
 * `listProducts` still narrows first via `isProductCategoryName` — not for this function's type
 * signature, but because its own `category` query parameter needs a different `details.field` than
 * this function's default `'categoryName'` on the thrown error.
 * @throws ValidationError when `categoryName` names no seeded category.
 */
export function productCategoryIdFor(categoryName: string): ProductCategoryId {
  const id = PRODUCT_CATEGORY_ID_BY_NAME.get(categoryName);
  if (id === undefined) {
    throw new ValidationError(`unknown product category "${categoryName}"`, {
      details: { field: 'categoryName' },
    });
  }
  return id;
}

/**
 * `product_category_id -> categoryName`, the reverse direction — read back off a row this
 * module's own write just returned. A miss here is schema drift (a `product_category_id` in the
 * database with no matching entry in `PRODUCT_CATEGORY`), never a caller's fault.
 * @throws InternalError when `productCategoryId` names no seeded category.
 */
export function productCategoryNameFor(productCategoryId: number): ProductCategoryName {
  const name = PRODUCT_CATEGORY_NAME_BY_ID.get(productCategoryId);
  if (name === undefined) {
    throw new InternalError(`unknown product_category_id ${productCategoryId}`);
  }
  return name;
}

/**
 * `review_moderation_state_id -> name`, read back off a review row. Same schema-drift reasoning
 * as {@link productCategoryNameFor}.
 * @throws InternalError when `reviewModerationStateId` names no seeded state.
 */
export function reviewModerationStateNameFor(
  reviewModerationStateId: number,
): ReviewModerationStateName {
  const name = REVIEW_MODERATION_STATE_NAME_BY_ID.get(reviewModerationStateId);
  if (name === undefined) {
    throw new InternalError(`unknown review_moderation_state_id ${reviewModerationStateId}`);
  }
  return name;
}
