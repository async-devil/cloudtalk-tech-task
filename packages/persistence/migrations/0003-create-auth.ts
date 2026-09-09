import { type Kysely, sql } from 'kysely';

/**
 * The `auth` schema: four better-auth-mapped tables plus the app-owned `app_user` record. The
 * owning module is `auth`; the DDL artifact lives here because there is one migration folder with
 * one global index sequence (ADR-0006) — per-module folders make cross-module ordering a matter of
 * luck.
 *
 * **The id-column exception, stated because it breaks this repository's own naming rule.** ADR-0011
 * names primary keys `<table>_id`. better-auth 1.6.23's Kysely adapter names the primary-key column
 * `id` unconditionally — it is not mappable through the public `<model>.fields` config, which never
 * includes `id` (verified against the pinned `@better-auth/core` `get-tables`/`get-field-name` and
 * `@better-auth/kysely-adapter` sources, not assumed). So the four LIBRARY tables keep the
 * library's native `id`, confined to this schema, and are allowlisted in the migration-DDL gate
 * with a comment pointing here. Nothing is lost: domain tables reference `auth.app_user.app_user_id`
 * — ours, below — and never a library-minted identifier, which is the guarantee that actually
 * matters. The column is still ADR-0011-shaped otherwise: `uuid DEFAULT uuidv7()`, with
 * `advanced.database.generateId: 'uuid'` making better-auth omit the id on insert so the database
 * default mints it, exactly like every other table here.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE SCHEMA auth`.execute(db);

  // -------------------------------------------------------------------------------------------
  // auth.identity — better-auth's `user` model. `user` is a reserved word (ADR-0011), and
  // `identity` says what the library's record actually is: the authentication identity, which is
  // not the same thing as the application's user.
  // -------------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE auth.identity (
      id             uuid NOT NULL DEFAULT uuidv7(),
      name           text NOT NULL,
      email          text NOT NULL,
      email_verified boolean NOT NULL DEFAULT false,
      image          text,
      created_at     timestamptz NOT NULL DEFAULT now(),
      updated_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_identity PRIMARY KEY (id),
      CONSTRAINT uq_identity__email UNIQUE (email)
    )
  `.execute(db);
  await sql`
    COMMENT ON TABLE auth.identity IS
      'better-auth''s user model: the library''s authentication identity. Its id is confined to the auth schema — domain tables reference auth.app_user.app_user_id, never this id.'
  `.execute(db);
  await sql`
    CREATE TRIGGER tg_identity__set_updated_at
      BEFORE UPDATE ON auth.identity
      FOR EACH ROW EXECUTE FUNCTION persistence.set_updated_at()
  `.execute(db);

  // -------------------------------------------------------------------------------------------
  // auth.session — better-auth `session`. `identity_id` maps from session.userId.
  // -------------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE auth.session (
      id          uuid NOT NULL DEFAULT uuidv7(),
      expires_at  timestamptz NOT NULL,
      token       text NOT NULL,
      ip_address  text,
      user_agent  text,
      identity_id uuid NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      updated_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_session PRIMARY KEY (id),
      CONSTRAINT uq_session__token UNIQUE (token),
      CONSTRAINT fk_session__identity FOREIGN KEY (identity_id)
        REFERENCES auth.identity (id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX ix_session__identity_id ON auth.session (identity_id)`.execute(db);
  await sql`
    CREATE TRIGGER tg_session__set_updated_at
      BEFORE UPDATE ON auth.session
      FOR EACH ROW EXECUTE FUNCTION persistence.set_updated_at()
  `.execute(db);

  // -------------------------------------------------------------------------------------------
  // auth.account — better-auth `account`: the provider links behind an identity.
  // `provider_account_id` maps from accountId (the provider's own id), `provider_id` from
  // providerId, `identity_id` from userId.
  // -------------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE auth.account (
      id                       uuid NOT NULL DEFAULT uuidv7(),
      identity_id              uuid NOT NULL,
      provider_id              text NOT NULL,
      provider_account_id      text NOT NULL,
      access_token             text,
      refresh_token            text,
      id_token                 text,
      access_token_expires_at  timestamptz,
      refresh_token_expires_at timestamptz,
      scope                    text,
      password                 text,
      created_at               timestamptz NOT NULL DEFAULT now(),
      updated_at               timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_account PRIMARY KEY (id),
      CONSTRAINT fk_account__identity FOREIGN KEY (identity_id)
        REFERENCES auth.identity (id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`CREATE INDEX ix_account__identity_id ON auth.account (identity_id)`.execute(db);
  await sql`
    CREATE TRIGGER tg_account__set_updated_at
      BEFORE UPDATE ON auth.account
      FOR EACH ROW EXECUTE FUNCTION persistence.set_updated_at()
  `.execute(db);

  // -------------------------------------------------------------------------------------------
  // auth.verification — better-auth `verification`: the magic-link and verification payloads.
  // These are short-lived credentials, and the retention pass purges them on their own horizon.
  // -------------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE auth.verification (
      id         uuid NOT NULL DEFAULT uuidv7(),
      identifier text NOT NULL,
      value      text NOT NULL,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_verification PRIMARY KEY (id)
    )
  `.execute(db);
  await sql`CREATE INDEX ix_verification__identifier ON auth.verification (identifier)`.execute(db);
  await sql`
    CREATE TRIGGER tg_verification__set_updated_at
      BEFORE UPDATE ON auth.verification
      FOR EACH ROW EXECUTE FUNCTION persistence.set_updated_at()
  `.execute(db);

  // -------------------------------------------------------------------------------------------
  // auth.app_user — the APP-OWNED user record. Our uuid, our token, and a same-schema foreign key
  // to the library's identity row. Domain tables reference `app_user_id` and never a
  // library-minted identifier, which is what makes better-auth swappable behind this one row.
  // -------------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE auth.app_user (
      app_user_id uuid NOT NULL DEFAULT uuidv7(),
      identity_id uuid NOT NULL,
      token       text NOT NULL,
      created_at  timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_app_user PRIMARY KEY (app_user_id),
      CONSTRAINT uq_app_user__identity_id UNIQUE (identity_id),
      CONSTRAINT uq_app_user__token UNIQUE (token),
      CONSTRAINT ck_app_user__token_format CHECK (token ~ '^usr_[0-9A-Za-z]{21}$'),
      CONSTRAINT fk_app_user__identity FOREIGN KEY (identity_id)
        REFERENCES auth.identity (id) ON DELETE CASCADE
    )
  `.execute(db);
  await sql`
    COMMENT ON TABLE auth.app_user IS
      'The APP-OWNED user record: domain tables reference app_user_id and never a library-minted identifier, which is what makes the auth library swappable behind this one row. Created by the session-create hook.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN auth.app_user.identity_id IS
      'The authentication identity this user signs in as. ON DELETE CASCADE: identity deletion is user erasure''s first domino.'
  `.execute(db);
}

/** Local development only (ADR-0006): a production rollback is a forward migration plus the
 * pre-migration dump. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE auth.app_user`.execute(db);
  await sql`DROP TABLE auth.verification`.execute(db);
  await sql`DROP TABLE auth.account`.execute(db);
  await sql`DROP TABLE auth.session`.execute(db);
  await sql`DROP TABLE auth.identity`.execute(db);
  await sql`DROP SCHEMA auth`.execute(db);
}
