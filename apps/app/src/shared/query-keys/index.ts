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
} as const;
