import { type Kysely, sql } from 'kysely';

/**
 * Transaction-scoped advisory lock keyed by `(product_id, author_id)` (ADR-0007 step 2, SPEC-0004)
 * — MUST be the FIRST statement inside an already-open transaction
 * (`db.transaction().execute(...)`); it is a no-op outside one and self-releases on
 * commit/rollback/crash.
 *
 * `@repo/jobs` keeps its own two-line equivalent in `internal/advisory-lock.ts`
 * (`acquireInstanceLock`, keyed by `{pipeline}:{instanceId}`) — reaching into it would be a
 * cross-module internals import, forbidden by ADR-0001 regardless of how small the duplicated
 * body is. This is the one deliberate duplication in this module, named here rather than silently
 * repeated.
 */
export async function acquireReviewLock(
  trx: Kysely<unknown>,
  productId: string,
  authorId: string,
): Promise<void> {
  const lockKey = `reviews.review:${productId}:${authorId}`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);
}
