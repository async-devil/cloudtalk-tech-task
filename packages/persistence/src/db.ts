import { Kysely, PostgresDialect } from 'kysely';
import { Pool, type PoolConfig } from 'pg';

/** Options for {@link createDb}. */
export interface DbOptions {
  readonly connectionString: string;
  /** pg pool `max`; default 10. */
  readonly poolSize?: number;
  /** pg `application_name`; the composition root passes its service name — the default *is* the
   * service name, which only the composing app knows; when omitted here the driver's own
   * default applies. */
  readonly applicationName?: string;
}

/**
 * Creates a pooled Kysely handle over pg's `Pool` + `PostgresDialect` (ADR-0003). Modules
 * receive handles by injection from the composition root — they never import this factory.
 */
export function createDb<DB>(options: DbOptions): Kysely<DB> {
  const config: PoolConfig = {
    connectionString: options.connectionString,
    max: options.poolSize ?? 10,
    ...(options.applicationName !== undefined ? { application_name: options.applicationName } : {}),
  };
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool: new Pool(config) }) });
}

/** Destroys the handle and its underlying pool (idempotent per Kysely's own contract). */
export async function destroyDb(db: Kysely<unknown>): Promise<void> {
  await db.destroy();
}
