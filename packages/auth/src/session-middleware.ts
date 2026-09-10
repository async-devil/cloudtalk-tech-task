import { ForbiddenError, InternalError, UnauthorizedError } from '@repo/kernel';
import { rowAs } from '@repo/persistence';
import { Elysia } from 'elysia';
import { type Kysely, sql } from 'kysely';
import type { AuthApi } from './factory.js';
import { observability } from './internal/observability.js';
import { appUserRowSchema } from './internal/rows.js';

/**
 * The per-request resolved session.
 *
 * It has exactly one dimension — a user — and that is ADR-0013's decision rather than an omission.
 * This product has one catalogue and one set of reviewers; a tenant or organization dimension that
 * nothing consumes is a boundary nobody maintains correctly, and it would have to be threaded
 * through every scoped query to stay honest.
 */
export interface RequestSession {
  /** `auth.app_user.app_user_id` — the app-owned id. Server-side only, never serialized. */
  readonly userId: string;
  /** `auth.app_user.token` — the only user identifier that may cross the wire (ADR-0011). */
  readonly userToken: string;
  /**
   * `auth.app_user.catalogue_manager` (TASK-0008, ADR-0018): whether this session's user holds the
   * capability to create and edit catalogue products. Server-side only, like `userId` — never
   * serialized as-is; the bootstrap payload exposes it under a deliberately different name
   * (`canManageCatalogue`, SPEC-0003) so the wire field is never mistaken for the source of truth.
   * {@link requireCatalogueManager} is the boundary that actually enforces it.
   */
  readonly catalogueManager: boolean;
  /**
   * `auth.app_user.moderator` (TASK-0009, ADR-0018): whether this session's user holds the
   * capability to reject a review and restore a rejected one. Independent of `catalogueManager` —
   * holding one implies nothing about the other (ADR-0018). Server-side only, never serialized
   * as-is; the bootstrap payload exposes it as `canModerate` (SPEC-0003), the same deliberately
   * different name convention `canManageCatalogue` already sets. {@link requireModerator} is the
   * boundary that actually enforces it.
   */
  readonly moderator: boolean;
}

/** Dependencies for the session middleware. */
export interface SessionMiddlewareDependencies {
  readonly api: AuthApi;
  readonly db: Kysely<unknown>;
}

/**
 * The framework-agnostic core, so resolution is unit- and container-testable without an HTTP
 * server: session lookup, then the identity's `app_user` row in one indexed read. No session
 * yields `undefined` and lets the guards decide; a session whose identity has no `app_user` row is
 * an internal inconsistency rather than an authentication failure, and says so. Caches nothing.
 *
 * Exported beside the Elysia plugin below because the mounted oRPC handler is a WinterCG fetch
 * handler and Elysia's `.derive` does not fire for mounted routes (ADR-0004 records that
 * mechanic). The contract routes therefore resolve the session through this function directly,
 * into their own context.
 */
export async function resolveRequestSession(
  deps: SessionMiddlewareDependencies,
  headers: Headers,
): Promise<RequestSession | undefined> {
  return await observability.withSpan('auth.session.resolve', async (span) => {
    const lookup = await deps.api.getSession({ headers });
    if (lookup === null) {
      return undefined;
    }
    const result = await sql`
      SELECT app_user_id, token, catalogue_manager, moderator FROM auth.app_user
      WHERE identity_id = ${lookup.session.userId}::uuid
    `.execute(deps.db);
    if (result.rows[0] === undefined) {
      throw new InternalError('auth: session references an identity with no auth.app_user row', {
        details: { identityId: lookup.session.userId },
      });
    }
    const appUser = rowAs(appUserRowSchema, result.rows[0]);
    span.setAttribute('appUserId', appUser.app_user_id);
    return {
      userId: appUser.app_user_id,
      userToken: appUser.token,
      catalogueManager: appUser.catalogue_manager,
      moderator: appUser.moderator,
    };
  });
}

/**
 * The Elysia session plugin: derives `{ session?: RequestSession }` for Elysia-native routes.
 * Contract routes go through {@link resolveRequestSession} instead, for the mounted-handler reason
 * documented above. Registering this plugin is the composition root's job (ADR-0005).
 */
export function createSessionMiddleware(deps: SessionMiddlewareDependencies) {
  return new Elysia({ name: 'auth-session' }).derive(async ({ request }) => ({
    session: await resolveRequestSession(deps, request.headers),
  }));
}

/**
 * Guard for route handlers that need authentication: returns the resolved session, or throws
 * `UnauthorizedError` (401) when there is none. Authorship-scoped reads then filter on
 * `session.userId` — there is no ambient scoping layer doing it for them, which is the trade
 * ADR-0013 accepted when it dropped the tenant dimension.
 */
export function requireSession(context: { readonly session?: RequestSession }): RequestSession {
  if (context.session === undefined) {
    throw new UnauthorizedError('authentication required');
  }
  return context.session;
}

/**
 * Guard for route handlers that need the `catalogue_manager` capability (TASK-0008, ADR-0018,
 * SPEC-0003) — strictly stronger than {@link requireSession}: no session still 401s (via
 * `requireSession` itself), and a resolved session whose user does not hold the capability 403s,
 * rather than being let through. The two-code distinction is TASK-0008's own acceptance criterion
 * ("a request with no session receives 401; a request with a session lacking the capability
 * receives 403"), encoded once here rather than left for every capability-gated router to
 * reimplement — the same reason `requireSession` itself is a shared function and not an inline
 * check at each call site.
 */
export function requireCatalogueManager(context: {
  readonly session?: RequestSession;
}): RequestSession {
  const session = requireSession(context);
  if (!session.catalogueManager) {
    throw new ForbiddenError('catalogue_manager capability required');
  }
  return session;
}

/**
 * Guard for route handlers that need the `moderator` capability (TASK-0009, ADR-0018, SPEC-0003) —
 * the identical shape {@link requireCatalogueManager} establishes, for the other capability: no
 * session still 401s (via {@link requireSession}), and a resolved session whose user does not hold
 * `moderator` — including one that holds only `catalogue_manager` — 403s rather than being let
 * through. Both capabilities are independent booleans (ADR-0018): holding one never satisfies this
 * guard on its own.
 */
export function requireModerator(context: { readonly session?: RequestSession }): RequestSession {
  const session = requireSession(context);
  if (!session.moderator) {
    throw new ForbiddenError('moderator capability required');
  }
  return session;
}
