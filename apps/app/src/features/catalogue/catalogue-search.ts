import { z } from 'zod';

/**
 * The catalogue's URL search-param shape (SPEC-0001 S2): "the URL is the state" — every control on
 * the screen (the search box, the category filter, the sort control) reads and writes ONE of these
 * fields, and nothing about the active filter set lives in React state the URL does not reflect.
 * `catalogue-screen.tsx` is the only consumer of the accessors below; the route
 * (`routes/index.tsx`) owns `validateSearch` itself (the `sign-in.tsx` convention) but imports this
 * schema rather than restating it, so the route and the slice can never drift on what a valid
 * catalogue URL looks like.
 *
 * Every field is lenient (`.catch`), mirroring `sign-in.tsx`'s own `returnTo` precedent: a
 * hand-edited or stale URL must degrade to "no filter", never blank the whole screen with a
 * validation error over a query string the user does not control by typing Zod.
 */
export const CATALOGUE_SORTS = ['rating', 'recent', 'name'] as const;
export type CatalogueSort = (typeof CATALOGUE_SORTS)[number];

export const catalogueSearchSchema = z.object({
  /** Substring match on product name or SKU (`productsContract`'s own doc on `query`). */
  query: z.string().trim().max(80).optional().catch(undefined),
  /** An exact `PRODUCT_CATEGORY` name (TASK-0004's own note: there is no wire-exposed category
   * vocabulary for a `<select>` to enumerate — `@repo/entities`'s `PRODUCT_CATEGORY` is a backend
   * package this app has no sanctioned edge to, and inventing a hardcoded copy of it here is
   * exactly the drift ADR-0003's "one source of truth" rule exists to prevent — so this is a
   * free-text field; an unrecognised value comes back from the api as `VALIDATION` with
   * `details.field: 'category'` and renders through the same error-state path every other query
   * failure does. */
  category: z.string().trim().max(80).optional().catch(undefined),
  sort: z.enum(CATALOGUE_SORTS).catch('rating').default('rating'),
  /**
   * Accepted on the URL (an incoming deep link that names a cursor must not fail validation), but
   * NOT written back to it by this slice's own "Load more" — see `use-catalogue-products.ts`'s
   * header for why. Kept here only so a URL a caller constructed by hand still parses.
   */
  cursor: z.string().optional().catch(undefined),
});
export type CatalogueSearch = z.infer<typeof catalogueSearchSchema>;

/** The subset of {@link CatalogueSearch} that identifies a FILTER (not a pagination position) —
 * what `use-catalogue-products.ts` builds the `products.list` input from, and what the query key
 * is scoped to. */
export interface CatalogueFilters {
  readonly query: string | undefined;
  readonly category: string | undefined;
  readonly sort: CatalogueSort;
}

export function filtersFromSearch(search: CatalogueSearch): CatalogueFilters {
  return { query: search.query, category: search.category, sort: search.sort };
}

/** Whether any filter is active — drives the "empty (filter matched nothing)" vs "empty (no
 * products)" branch (SPEC-0001 S2) and the clear-filters action's visibility. */
export function hasActiveFilter(filters: CatalogueFilters): boolean {
  return filters.query !== undefined || filters.category !== undefined;
}
