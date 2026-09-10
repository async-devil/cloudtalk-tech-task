/**
 * Builds a RESOLVED session's dependencies against {@link fakePostgresDb}: `deps.session.api`
 * returns a canned better-auth-shaped lookup, and `deps.session.db` (the SAME `Kysely<unknown>`
 * handle a caller should also pass as `HttpHandlerDeps.db`, mirroring `runtime/main.ts`'s own "one
 * connection" wiring) answers `resolveRequestSession`'s `auth.app_user` join with the given
 * `userId`/`userToken`, so the app resolves a REAL `RequestSession` with no cookie, no better-auth
 * instance, and no container. Any query beyond that lookup — a capability module's own reads and
 * writes — falls to the caller-supplied `respond`.
 */
import type { SessionMiddlewareDependencies } from '@repo/auth';
import type { Kysely } from 'kysely';
import { type FakeQueryResponder, fakePostgresDb } from './fake-postgres.js';

export interface FakeResolvedSessionOptions {
  readonly identityId: string;
  readonly userId: string;
  readonly userToken: string;
  /** `auth.app_user.catalogue_manager` (TASK-0008) — the row `resolveRequestSession`'s own query
   * reads. Defaults to `false`: most callers of this harness are exercising review ownership, not
   * the catalogue-authoring capability, and a fail-closed default keeps that the case unless a test
   * opts in. */
  readonly catalogueManager?: boolean;
  readonly respond?: FakeQueryResponder;
}

export interface FakeResolvedSession {
  readonly session: SessionMiddlewareDependencies;
  /** The same handle `session.db` uses — pass this as `HttpHandlerDeps.db` too, exactly as
   * `runtime/main.ts` wires one pool for both. */
  readonly db: Kysely<unknown>;
}

export function fakeResolvedSession(options: FakeResolvedSessionOptions): FakeResolvedSession {
  const db = fakePostgresDb((sql, parameters) => {
    // Matched on the exact column list `resolveRequestSession` selects — NOT a bare
    // `from auth.app_user` substring, which `authorLabelsForUserIds`' JOIN query also contains
    // (`FROM auth.app_user au JOIN auth.identity ai ...`) and would otherwise wrongly intercept,
    // starving that query of the `email` column its own row schema requires.
    if (
      sql.toLowerCase().includes('select app_user_id, token, catalogue_manager from auth.app_user')
    ) {
      return {
        rows: [
          {
            app_user_id: options.userId,
            token: options.userToken,
            catalogue_manager: options.catalogueManager ?? false,
          },
        ],
      };
    }
    return options.respond?.(sql, parameters) ?? { rows: [] };
  });

  return {
    db,
    session: {
      api: {
        getSession: () =>
          Promise.resolve({
            session: { userId: options.identityId },
            user: { id: options.identityId, email: 'unused-in-tests@example.test' },
          }),
      },
      db,
    },
  };
}
