import { ERROR_CODE } from '@repo/kernel';
import { partialMatchKey, type QueryClient } from '@tanstack/react-query';
import { queryKeys } from '../query-keys/index.js';
import { toApiError } from './api-error.js';

/** Where the user was when the 401 landed, in the shape the `/sign-in` route's `returnTo` search
 * param expects (path + search + hash, never an absolute URL — see `sign-in`'s own validation). */
export type CurrentLocationReader = () => string;

/** What to do about a 401. Injected rather than imported so this module stays free of the router
 * (`shared/` may not import routes — the slice-isolation rule) and testable without one. */
export type UnauthorizedHandler = (returnTo: string) => void;

/**
 * Installs the ONE 401 handler for the whole app (ADR-0012): a cache-level subscriber that fires
 * whenever any query or mutation settles with an `UNAUTHORIZED` error.
 *
 * Router-level and exactly once is the point. A per-feature `if (error.code === 'UNAUTHORIZED')`
 * is the pattern this replaces: it has to be repeated in every hook, it is invisible when
 * forgotten, and it makes "session expired" behaviour a per-screen accident. Features therefore
 * never handle 401 at all — it is not their concern, and a review that sees them doing it rejects
 * the change.
 *
 * BOTH caches are subscribed: a session can expire just as easily under a mutation as under a
 * read, and a 401 that only redirected on reads would strand the user on a form that silently
 * refuses to submit.
 *
 * THE SESSION BOOTSTRAP QUERY ITSELF IS EXCLUDED (TASK-0004, added once `/` and `/products` became
 * Visitor surface — SPEC-0001 J1). Before that, every `useQuery(sessionBootstrapQueryOptions)` ran
 * only on an already-guarded route, so its 401 and "session expired" were the same fact. That
 * stopped being true the moment a PUBLIC screen started calling `useSession()` on purpose (the
 * catalogue's "Signed in as…" line, `product-detail`'s own-review/sign-in-prompt branch): an
 * anonymous visitor's bootstrap call 401s as its NORMAL, expected answer — `shared/session`'s own
 * `loadSessionBootstrap` already treats that 401 as "no session", not an error — and without this
 * exclusion this subscriber disagreed, bounced the visitor to `/sign-in`, and defeated the whole
 * point of the route being public. Every OTHER query and every mutation is unaffected: a 401 from
 * `reviews.submit`/`update`/`remove` (or any future session-required read) still means exactly what
 * it always meant — the session ended mid-action — and still redirects.
 *
 * @returns an unsubscribe function (both caches), so a test — or a future multi-root host — can
 * tear the subscription down.
 */
export function installUnauthorizedRedirect(
  queryClient: QueryClient,
  onUnauthorized: UnauthorizedHandler,
  readCurrentLocation: CurrentLocationReader = defaultLocationReader,
): () => void {
  const handle = (error: unknown): void => {
    if (toApiError(error).code !== ERROR_CODE.Unauthorized) {
      return;
    }
    onUnauthorized(readCurrentLocation());
  };

  const unsubscribeQueries = queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== 'updated' || event.action.type !== 'error') {
      return;
    }
    if (partialMatchKey(event.query.queryKey, queryKeys.session.bootstrap())) {
      return;
    }
    handle(event.action.error);
  });
  const unsubscribeMutations = queryClient.getMutationCache().subscribe((event) => {
    if (event.type === 'updated' && event.action.type === 'error') {
      handle(event.action.error);
    }
  });

  return () => {
    unsubscribeQueries();
    unsubscribeMutations();
  };
}

function defaultLocationReader(): string {
  const { pathname, search, hash } = window.location;
  return `${pathname}${search}${hash}`;
}
