import { ERROR_CODE } from '@repo/kernel';
import type { QueryClient } from '@tanstack/react-query';
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
    if (event.type === 'updated' && event.action.type === 'error') {
      handle(event.action.error);
    }
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
