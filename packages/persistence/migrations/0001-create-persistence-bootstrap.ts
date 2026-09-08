import { type Kysely, sql } from 'kysely';

/**
 * The persistence bootstrap migration — the first resident of
 * `packages/persistence/migrations/`, needed because neither of its two objects is owned by a
 * single feature module:
 *
 * - `CREATE SCHEMA reference` — belongs to no single module (every context's closed vocabularies
 * are seeded into it, ADR-0006), so no module-owned migration may create it; the shared,
 * DB-owning module is the honest owner. `IF NOT EXISTS` stays banned (ADR-0006) precisely so a
 * second, accidental creator is a migration failure, not a silent no-op.
 * - `persistence.set_updated_at()` — the shared `BEFORE UPDATE` trigger function every row-level
 * `updated_at` column relies on (ADR-0006), placed in the `persistence` schema (every module
 * gets one) because a function is not reference *data*.
 *
 * Global migration index `0001`: `reference` must exist before
 * `packages/persistence/migrations/0002-create-jobs-spine.ts` seeds its four vocabularies into
 * it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE SCHEMA persistence`.execute(db);
  await sql`CREATE SCHEMA reference`.execute(db);

  await sql`
    CREATE FUNCTION persistence.set_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
    BEGIN
      NEW.updated_at := now();
      RETURN NEW;
    END;
    $$
  `.execute(db);

  await sql`
    COMMENT ON FUNCTION persistence.set_updated_at() IS
      'Shared BEFORE UPDATE trigger function (ADR-0011): the only sanctioned way to maintain a row-level updated_at column.'
  `.execute(db);
}

/** Local development only (ADR-0003): production rollback is roll-forward + pre-migration dump. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP FUNCTION persistence.set_updated_at()`.execute(db);
  await sql`DROP SCHEMA reference`.execute(db);
  await sql`DROP SCHEMA persistence`.execute(db);
}
