import { type Kysely, sql } from 'kysely';

/**
 * Per-instance mutual exclusion (frozen): `pg_advisory_xact_lock` on
 * `hashtextextended({pipeline}:{instanceId}, 0)` — transaction-scoped (self-releasing on
 * commit/rollback/crash), one bigint key, collision-tolerant (a hash collision serializes two
 * unrelated instances; it never corrupts). MUST be called as the first statement inside an
 * already-open transaction (`db.transaction().execute(...)`) — it is a no-op outside one.
 */
export async function acquireInstanceLock(
  trx: Kysely<unknown>,
  pipeline: string,
  instanceId: string,
): Promise<void> {
  const lockKey = `${pipeline}:${instanceId}`;
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`.execute(trx);
}
