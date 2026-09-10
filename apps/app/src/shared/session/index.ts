import type { SessionBootstrap } from '@repo/contracts';
import { ERROR_CODE } from '@repo/kernel';
import { type QueryClient, queryOptions, useQuery } from '@tanstack/react-query';
import { apiClient } from '../api/index.js';
import { toApiError } from '../errors/index.js';
import { queryKeys } from '../query-keys/index.js';

/**
 * What a signed-in client knows about itself.
 *
 * `userToken` is a PUBLIC token, never the internal user id: that uuid never reaches this process
 * at all — the client has no use for it, and an id it never sees is one it can never leak.
 */
export interface SessionState {
  readonly userToken: string;
  /**
   * `SessionBootstrap.canManageCatalogue` (TASK-0008, SPEC-0003): whether this session may create
   * and edit catalogue products. Surfaced here so the `catalogue`/`product-detail` screens can gate
   * their manager entry points on it — a COURTESY gate only: the server's own `catalogue_manager`
   * capability guard (`@repo/auth`'s `requireCatalogueManager`) is the actual security boundary and
   * refuses the write regardless of what this field says (SPEC-0001's own note: "if they ever
   * disagree, the server is right").
   */
  readonly canManageCatalogue: boolean;
  /**
   * `SessionBootstrap.canModerate` (TASK-0009, SPEC-0003): whether this session may reject a
   * review and restore a rejected one. Surfaced here so the `moderation` slice's screen and entry
   * point can gate on it — a COURTESY gate only, mirroring `canManageCatalogue` exactly: the
   * server's own `moderator` capability guard (`@repo/auth`'s `requireModerator`) is the actual
   * security boundary and refuses `reviews.reject`/`restore`/`moderationList` regardless of what
   * this field says.
   */
  readonly canModerate: boolean;
}

/**
 * The one query behind everything session-shaped: server state lives in Query, so the guard, the
 * hook below and any future feature all read the SAME cache entry and one request serves them all.
 *
 * `retry: false` on purpose: the answer "you are not signed in" arrives as a 401, and retrying it
 * three times only delays the redirect. `staleTime` bounds how often a full page's worth of
 * navigations re-asks.
 */
export const sessionBootstrapQueryOptions = queryOptions({
  queryKey: queryKeys.session.bootstrap(),
  queryFn: () => apiClient.session.bootstrap(),
  retry: false,
  staleTime: 30_000,
});

/**
 * Resolves the bootstrap for the root guard: the payload when signed in, `undefined` when the api
 * says 401.
 *
 * The 401 is translated to `undefined` HERE rather than thrown, because for a guard "no session"
 * is a normal answer that produces a redirect, not an error to surface. Every OTHER failure —
 * network down, 500, malformed payload — still throws, so a broken backend renders the router's
 * error boundary instead of silently pretending the user is signed out and bouncing them to a
 * sign-in screen that will not work either.
 */
export async function loadSessionBootstrap(
  queryClient: QueryClient,
): Promise<SessionBootstrap | undefined> {
  try {
    return await queryClient.ensureQueryData(sessionBootstrapQueryOptions);
  } catch (error) {
    const apiError = toApiError(error);
    if (apiError.code === ERROR_CODE.Unauthorized) {
      return undefined;
    }
    throw apiError;
  }
}

/**
 * The React-facing view of the session: `undefined` while loading and when unauthenticated —
 * components under a guarded route are only ever mounted with a session present, so they can
 * treat `undefined` as "not yet" rather than branching on auth themselves.
 */
export function useSession(): SessionState | undefined {
  const { data } = useQuery(sessionBootstrapQueryOptions);
  if (data === undefined) {
    return undefined;
  }
  return {
    userToken: data.userToken,
    canManageCatalogue: data.canManageCatalogue,
    canModerate: data.canModerate,
  };
}
