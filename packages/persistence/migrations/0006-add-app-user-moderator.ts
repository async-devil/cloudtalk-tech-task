import { type Kysely, sql } from 'kysely';

/**
 * Adds the `moderator` capability flag to `auth.app_user` (TASK-0009, SPEC-0002, ADR-0018). Global
 * migration index `0006`, on the single sequence every module shares (ADR-0006): one statement, in
 * its own file rather than an edit to `0003-create-auth.ts` or to `0005-add-app-user-catalogue-
 * manager.ts` — a merged migration is immutable and append-only, and each capability is its own
 * reviewed change (ADR-0018) rather than a second column bolted onto an unrelated grant. It belongs
 * to the `auth` schema rather than `reviews` for the identical reason `0005` gives:
 * the capability is a property of the USER holding it, not of the reviews it grants access to
 * (ADR-0018).
 *
 * `NOT NULL DEFAULT false`: the `nullable-boolean` rule (ADR-0011, restated in ADR-0016) bans a
 * third state, and "unknown" is not a capability anyone holds — every existing row becomes a
 * non-moderator the instant this migration runs, the fail-closed default a capability that must be
 * granted, never assumed, requires.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    ALTER TABLE auth.app_user ADD COLUMN moderator boolean NOT NULL DEFAULT false
  `.execute(db);
  await sql`
    COMMENT ON COLUMN auth.app_user.moderator IS
      'The right to reject a review and restore a rejected one (ADR-0018, SPEC-0001 rules 9-12). A capability flag, not a role: enforced at the HTTP boundary (TASK-0009, ADR-0018) and merely reflected to the client as sessionBootstrapSchema.canModerate — a field deliberately named differently from this column so the bootstrap payload is never mistaken for the source of truth. Independent of catalogue_manager: holding one implies nothing about the other. Set by seed or by hand; there is no admin surface for it in v1 (SPEC-0001).'
  `.execute(db);
}

/** Local development only (ADR-0006): a production rollback is a forward migration. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE auth.app_user DROP COLUMN moderator`.execute(db);
}
