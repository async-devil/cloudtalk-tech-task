import { apiQuery } from '../api/index.js';

/**
 * `shared/query-keys` — the namespaced key factory (ADR-0012).
 *
 * One namespace per feature slice, slice name FIRST, so "invalidate everything this slice owns" is
 * a structural prefix match rather than a list of keys somebody has to remember to extend. A key is
 * built here and nowhere else — an inline array literal at a call site is a key no invalidation can
 * find.
 *
 * ---------------------------------------------------------------------------------------------
 * WHY THESE KEYS ARE *DERIVED* RATHER THAN WRITTEN AS FLAT ARRAYS
 *
 * `@orpc/tanstack-query` generates its own key for every `apiQuery.<ns>.<proc>.queryOptions()`,
 * shaped `[[...procedurePath], { type, input }]` — the path is a NESTED array. TanStack matches a
 * filter key with `partialMatchKey`, which recurses into nested arrays, so a nested prefix matches
 * where a flat one cannot:
 *
 *     partialMatchKey([['session','bootstrap'], {…}],  ['session']  )  ->  false  <- a flat literal
 *     partialMatchKey([['session','bootstrap'], {…}], [['session']] )  ->  true
 *
 * Measured, not reasoned — both rows are asserted in `test/query-keys.test.ts`. A hand-written
 * `all: ['session']` would therefore match NOTHING: `invalidateQueries({ queryKey:
 * queryKeys.session.all })` would invalidate zero queries while looking correct at the call site
 * and in review.
 *
 * Deriving from `apiQuery`'s own generator, rather than restating `[['session']]` by hand, is what
 * stops the two key spaces drifting apart when a procedure is renamed.
 *
 * The cost, named so it stays a decision rather than an accident: `shared/query-keys` now imports
 * `shared/api`. Both are shared-kernel modules, so no slice rule is broken, but it does invert the
 * intuitive layering (keys derived from the client, rather than the client keyed by them). The
 * alternative is the drift this comment exists to prevent.
 * ---------------------------------------------------------------------------------------------
 */
/** Mirrors `productsListInputSchema` (`@repo/contracts`) — not re-exported from that package, so
 * restated here structurally. Every field optional, matching the wire input before Zod's own
 * `.default('rating')`/`.default(20)` apply (a key built with neither present still partial-matches
 * a live key that carries the resolved defaults, since partial matching only requires the fields
 * THIS object names). */
interface ProductsListKeyInput {
  readonly query?: string;
  readonly category?: string;
  readonly sort?: 'rating' | 'recent' | 'name';
  readonly cursor?: string;
  readonly limit?: number;
}

export const queryKeys = {
  /**
   * Not a feature slice: the session bootstrap is shared-kernel state that the router guards read
   * before any feature exists. It lives here because the rule above admits no exceptions —
   * including for the kernel's own query.
   */
  session: {
    all: apiQuery.session.key(),
    bootstrap: () => apiQuery.session.bootstrap.key({ type: 'query' }),
  },

  /**
   * `products.list`/`products.get` (SPEC-0001 S2/S3), read by the `catalogue` slice's list and the
   * `product-detail` slice's header — two slices, so the KEY FACTORY lives here even though
   * neither procedure is session-shaped, the same reasoning `session` above documents.
   *
   * `list` is `type: 'infinite'`: the catalogue's "Load more" is `useInfiniteQuery`
   * (`features/catalogue/use-catalogue-products.ts`'s own header explains the choice), so this is
   * the key TYPE a live query actually registers under — a `'query'` key here would silently never
   * match it (the same failure class this file's header comment exists to prevent).
   */
  products: {
    all: apiQuery.products.key(),
    // `exactOptionalPropertyTypes`: the library's own `OperationKeyOptions.input` is `input?:
    // PartialDeep<TInput>`, not `| undefined` — so an `input` PROPERTY present with an `undefined`
    // VALUE fails to type-check even though the property itself is optional. Omitting the key
    // entirely (rather than passing it as `undefined`) is what the flag actually asks for.
    list: (input?: ProductsListKeyInput) =>
      apiQuery.products.list.key(
        input === undefined ? { type: 'infinite' } : { type: 'infinite', input },
      ),
    get: (productSlug: string) =>
      apiQuery.products.get.key({ type: 'query', input: { productSlug } }),
  },

  /**
   * `reviews.listForProduct` (SPEC-0001 S3/S4/S5): read by `product-detail`, invalidated by
   * `review-submit` on a successful submit/edit/delete — two slices, same rule.
   *
   * `listForProduct` takes only `productSlug`: a PARTIAL key on purpose, so
   * `invalidateQueries({ queryKey: queryKeys.reviews.listForProduct(slug) })` matches the live
   * infinite query regardless of its `cursor`/`limit` — see this file's header on why the nested
   * `input` object partial-matches rather than needing to be restated in full.
   */
  reviews: {
    all: apiQuery.reviews.key(),
    listForProduct: (productSlug: string) =>
      apiQuery.reviews.listForProduct.key({ type: 'infinite', input: { productSlug } }),
  },
} as const;
