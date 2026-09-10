/**
 * S7's live slug preview (SPEC-0001, TASK-0008) — a CLIENT-SIDE restatement of
 * `packages/reviews/src/products.ts`'s `deriveProductSlug`, not an import of it: this app never
 * depends on a backend package (ADR-0001), and the SPA has no sanctioned edge to `@repo/reviews`.
 * The rule is copied byte-for-byte on purpose — lowercase, every run of one-or-more
 * non-alphanumeric characters collapsed to a single hyphen, leading/trailing hyphens trimmed, then
 * trimmed again to {@link MAX_DERIVED_SLUG_LENGTH} characters (a hyphen run can land exactly on the
 * length boundary and reappear as a dangling trailing hyphen once the cut lands mid-run, so the
 * second trim matters) — so the preview shown here matches what the server will actually mint when
 * the user leaves the slug untouched.
 *
 * **This function's output is a PREVIEW ONLY.** SPEC-0001's own words: "Slug derivation runs
 * server-side even though the form previews it… a client-side slug is a suggestion; treating it as
 * the value makes the address depend on which client wrote the row." `product-form-machine.ts` only
 * ever sends this value to `products.create` when the user has explicitly edited it via "Edit slug"
 * — see that file's `slugTouched` handling.
 */

const NON_ALPHANUMERIC_RUN_RE = /[^a-z0-9]+/g;
const LEADING_OR_TRAILING_HYPHENS_RE = /^-+|-+$/g;
/** Mirrors `reviews.product`'s `ck_product__slug_length` upper bound (SPEC-0002) via
 * `packages/reviews/src/products.ts`'s own `MAX_DERIVED_SLUG_LENGTH` — restated, not imported. */
const MAX_DERIVED_SLUG_LENGTH = 80;

/** Derives the slug PREVIEW shown beneath the name field. Mirrors
 * `packages/reviews/src/products.ts`'s `deriveProductSlug` exactly. */
export function deriveProductSlugPreview(name: string): string {
  const collapsed = name
    .trim()
    .toLowerCase()
    .replace(NON_ALPHANUMERIC_RUN_RE, '-')
    .replace(LEADING_OR_TRAILING_HYPHENS_RE, '');
  return collapsed.slice(0, MAX_DERIVED_SLUG_LENGTH).replace(LEADING_OR_TRAILING_HYPHENS_RE, '');
}
