import { createAuthClient } from 'better-auth/client';
import { magicLinkClient } from 'better-auth/client/plugins';
import { API_ORIGIN } from '../api/index.js';

/**
 * The ONE better-auth client instance.
 *
 * WHY AUTH DOES NOT GO THROUGH `shared/api`: the auth routes are better-auth's, not `appContract`'s
 * — they are mounted beside the oRPC handler, not inside it (`apps/api`'s `buildApp`) — so there is
 * no contract procedure for `apiClient` to call. This module is the second, and last, place in the
 * app that talks to a server; `no-fetch-outside-shared-api` still holds, because the network call
 * happens inside the library rather than in a `fetch(` here.
 *
 * `baseURL` is the api ORIGIN, not `shared/api`'s `API_BASE_URL`: better-auth appends its own
 * `basePath` (`/api/auth`, pinned by `packages/auth`'s factory to match the mount), so passing the
 * already-`/api`-suffixed URL would address `/api/api/auth/*` and 404 every route.
 *
 * The SPA is CROSS-ORIGIN from the api in every environment, which has two consequences that are
 * easy to miss and fatal together:
 *   1. `credentials: 'include'` — the session cookie is `HttpOnly`, so only this flag sends it.
 *      The same reasoning as `shared/api`'s own fetch wrapper.
 *   2. the api must TRUST this origin — `packages/auth`'s `trustedOrigins`, fed from the same
 *      `HTTP_CORS_ALLOWED_ORIGINS` list as CORS. Without it better-auth answers 403 before any
 *      handler runs.
 */
export const authClient = createAuthClient({
  baseURL: API_ORIGIN,
  plugins: [magicLinkClient()],
  fetchOptions: {
    credentials: 'include',
  },
});

/** Where better-auth sends the browser after a magic link is verified. Absolute (this app's own
 * origin) rather than relative: a relative path resolves against the API's base URL, which would
 * land the user on the api origin instead of the app. */
export function magicLinkCallbackUrl(returnTo: string): string {
  return new URL(returnTo, window.location.origin).toString();
}
