import type { BrowserContext } from '@playwright/test';

/**
 * The e2e-only session-mock route (`apps/api/src/runtime/test-session-route.ts`, mounted only
 * under `APP_MODE=test`). Mirrored as a literal here rather than imported: `apps/app` never
 * depends on `apps/api`'s source (the wire contract is the SPA's entire boundary to the backend),
 * so this constant is the e2e harness's own copy of the path, not a cross-app import.
 * `test-session-route.test.ts` (apps/api) is what keeps the real route's path pinned; a change to
 * one without the other 404s every e2e spec that calls {@link authenticateAs}, loudly.
 */
export const TEST_SESSION_ROUTE_PATH = '/api/test/session';

/**
 * The magic-link reader, and the query parameter it REQUIRES (mirrored here as a literal for the
 * same reason the path above is — `apps/app` never imports `apps/api`'s source).
 *
 * The parameter is what makes this suite's parallelism safe: the api's mailbox holds every message
 * the process has sent, and two Playwright projects run at once, so an unscoped "last mail" read
 * could hand one project the other's single-use token. `apps/api/test/test-session-route.test.ts`
 * pins both the path and the 400-on-missing-parameter behaviour.
 */
export const TEST_LAST_MAGIC_LINK_ROUTE_PATH = '/api/test/last-magic-link';
export const MAGIC_LINK_EMAIL_QUERY_PARAMETER = 'email';

/** The reader's URL for one address. Built here so no spec hand-assembles the query string. */
export function lastMagicLinkUrl(apiBaseURL: string, email: string): string {
  return `${apiBaseURL}${TEST_LAST_MAGIC_LINK_ROUTE_PATH}?${MAGIC_LINK_EMAIL_QUERY_PARAMETER}=${encodeURIComponent(email)}`;
}

export interface AuthenticateAsOptions {
  /** The api's origin (not the SPA's) — `constants.ts`'s `API_BASE_URL` in every real spec. */
  readonly apiBaseURL: string;
  /** The address to mint a session for. Any string mints a session: the route signs a fresh user
   * up on first use (the suite's open-signup e2e posture, `harness/start-api-server.ts`) — callers
   * pick a unique-enough address per test to avoid two specs sharing one session by accident. */
  readonly email: string;
  /**
   * TASK-0008: when `true`, grants the newly-minted session's user the `catalogue_manager`
   * capability (`test-session-route.ts`'s own `catalogueManager` field) — what
   * `catalogue-authoring.spec.ts` uses in place of TASK-0006 seed data, which does not exist for
   * this spec to depend on. Omitted or `false` behaves exactly as before this field existed.
   */
  readonly catalogueManager?: boolean;
  /**
   * TASK-0009: the identical shortcut for the `moderator` capability (`test-session-route.ts`'s
   * own `moderator` field) — what `moderation.spec.ts` uses to sign in as a moderator without
   * seed data. Independent of `catalogueManager`: either, both, or neither may be `true` in one
   * call, mirroring the route's own "no artificial exclusivity" stance.
   */
  readonly moderator?: boolean;
}

/**
 * Mints a REAL better-auth session for `options.email` and stores it in `context`'s cookie jar in
 * one call: every `page` opened from `context` afterwards is authenticated, so specs never have to
 * drive the magic-link UI themselves. Exactly one spec (`specs/magic-link.spec.ts`) is exempt from
 * this shortcut and drives the real flow instead — see that file's header for why.
 *
 * Uses `context.request` (not the module-global `fetch`) on purpose: an `APIRequestContext`
 * obtained from a `BrowserContext` shares that context's cookie storage (Playwright's own
 * documented behaviour), so a `Set-Cookie` on this response is applied to `context` automatically
 * — there is no separate step to copy a cookie header across.
 */
export async function authenticateAs(
  context: BrowserContext,
  options: AuthenticateAsOptions,
): Promise<void> {
  const response = await context.request.post(`${options.apiBaseURL}${TEST_SESSION_ROUTE_PATH}`, {
    data: {
      email: options.email,
      ...(options.catalogueManager !== undefined
        ? { catalogueManager: options.catalogueManager }
        : {}),
      ...(options.moderator !== undefined ? { moderator: options.moderator } : {}),
    },
  });
  if (response.status() !== 204) {
    throw new Error(
      `authenticateAs(${options.email}): expected 204 from ${TEST_SESSION_ROUTE_PATH}, got ` +
        `${response.status()}: ${await response.text()}`,
    );
  }
}
