import { type Kysely, sql } from 'kysely';

/**
 * Adds the `catalogue_manager` capability flag to `auth.app_user` (TASK-0008, SPEC-0002, ADR-0018).
 * Global migration index `0005`, on the single sequence every module shares (ADR-0006): one
 * statement, in its own file rather than an edit to `0003-create-auth.ts`, because a merged
 * migration is immutable and append-only. It belongs to the `auth` schema rather than `reviews`
 * because the capability is a property of the USER holding it, not of the catalogue it grants
 * access to (ADR-0018) — `0006-add-app-user-moderator.ts` (TASK-0009, not this migration) will sit
 * beside it for the same reason, as its own reviewed change rather than a second column bolted onto
 * this one.
 *
 * `NOT NULL DEFAULT false`: the `nullable-boolean` rule (ADR-0011, restated in ADR-0016) bans a
 * third state, and "unknown" is not a capability anyone holds — every existing row becomes a
 * non-manager the instant this migration runs, which is the fail-closed default a capability that
 * must be granted, never assumed, requires.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE auth.app_user ADD COLUMN catalogue_manager boolean NOT NULL DEFAULT false
  `.execute(db);
  await sql`
    COMMENT ON COLUMN auth.app_user.catalogue_manager IS
      'The right to create and edit catalogue products (ADR-0018, SPEC-0001 rule 4). A capability flag, not a role: enforced at the HTTP boundary (TASK-0008, ADR-0018) and merely reflected to the client as sessionBootstrapSchema.canManageCatalogue — a field deliberately named differently from this column so the bootstrap payload is never mistaken for the source of truth. Set by seed or by hand; there is no admin surface for it in v1 (SPEC-0001).'
  `.execute(db);
}

/** Local development only (ADR-0006): a production rollback is a forward migration. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE auth.app_user DROP COLUMN catalogue_manager`.execute(db);
}
