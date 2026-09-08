import { Migrator } from 'kysely/migration';
import { createDb, destroyDb } from './db.js';
import { collectMigrations } from './internal/collect-migrations.js';

/** Options for {@link runMigrations}. Migration invariants are ADR-0003's (owner-only DDL, an
 * explicit entry point, never on boot). */
export interface MigrateOptions {
  /** Distinct owner connection (ADR-0003): app runtime roles cannot ALTER; only the owner
   * applies DDL, and only through this explicit entry point — never on boot. */
  readonly ownerConnectionString: string;
  /** Absolute paths to per-module migration folders, merged into one global order. */
  readonly migrationFolders: ReadonlyArray<string>;
}

/** The outcome of a {@link runMigrations} call (ADR-0003). */
export interface MigrationReport {
  readonly applied: ReadonlyArray<string>;
  readonly error?: { migration: string; cause: unknown };
}

/**
 * Merges the given per-module migration folders into one Kysely `Migrator` provider and runs
 * `migrateToLatest` on a dedicated single-connection owner handle (ADR-0003). Global
 * ordering is lexicographic on file name across all folders; a duplicate file name across
 * folders throws before anything touches the database. The Migrator's built-in migration lock
 * makes concurrent invocations safe.
 */
export async function runMigrations(options: MigrateOptions): Promise<MigrationReport> {
  const migrations = await collectMigrations(options.migrationFolders);

  const db = createDb<unknown>({
    connectionString: options.ownerConnectionString,
    poolSize: 1,
    applicationName: 'migrations',
  });

  try {
    const migrator = new Migrator({
      db,
      provider: { getMigrations: () => Promise.resolve(migrations) },
    });

    const { error, results } = await migrator.migrateToLatest();

    const applied = (results ?? [])
      .filter((result) => result.status === 'Success')
      .map((result) => result.migrationName);

    if (error !== undefined) {
      const failed = (results ?? []).find((result) => result.status === 'Error');
      return {
        applied,
        error: { migration: failed?.migrationName ?? '(unknown)', cause: error },
      };
    }

    return { applied };
  } finally {
    await destroyDb(db);
  }
}
