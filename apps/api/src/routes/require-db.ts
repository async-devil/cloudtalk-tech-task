import { InternalError } from '@repo/kernel';
import type { Kysely } from 'kysely';

/**
 * Fails closed with a typed 500 rather than letting `db === undefined` crash inside a capability
 * module's own `sql` calls — the same "absent dependency -> clean typed failure" shape
 * `requireSession` (`@repo/auth`) gives an absent `session` dependency, just for a different
 * dependency and a different code. Shared by `products.router.ts` and `reviews.router.ts`: both
 * close over the same composition-root `db` handle.
 */
export function requireDb(db: Kysely<unknown> | undefined): Kysely<unknown> {
  if (db === undefined) {
    throw new InternalError('no database configured for this route');
  }
  return db;
}
