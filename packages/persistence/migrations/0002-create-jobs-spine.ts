import { type Kysely, sql } from 'kysely';

/**
 * The jobs-spine migration (ADR-0003): schema `jobs`, the four `reference` vocabularies this
 * domain needs (`stage_status`, `branch_status`, `branch_kind`, `outbox_row_status` — each
 * `{ id, name }`, sourced from and parity-tested against `@repo/entities`), `jobs.dead_letter`,
 * and the pipeline-scoped purge index `purgeDeadLetters` (`packages/jobs/src/retention.ts`)
 * needs. The purge index is folded into this migration rather than kept as a later follow-up,
 * since this repository's migration history starts here.
 *
 * Global migration index `0002`: `reference` must already exist
 * (`packages/persistence/migrations/0001-create-persistence-bootstrap.ts`) before this migration
 * seeds vocabularies into it; later migrations (starting at `0003`) carry foreign keys into these
 * vocabularies and build on this schema.
 *
 * This repository has no RLS-scoped runtime roles — one connection owns both migrations and
 * runtime traffic (ADR-0003) — so this migration carries no `GRANT` statements: every schema it
 * creates is reachable through that single connection.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE SCHEMA jobs`.execute(db);

  // -----------------------------------------------------------------------------------------
  // reference.stage_status
  // -----------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE reference.stage_status (
      stage_status_id integer NOT NULL,
      name            text    NOT NULL,
      CONSTRAINT pk_stage_status PRIMARY KEY (stage_status_id),
      CONSTRAINT uq_stage_status__name UNIQUE (name)
    )
  `.execute(db);
  await sql`
    COMMENT ON TABLE reference.stage_status IS
      'Pipeline stage lifecycle (ADR-0011). Source: STAGE_STATUS in @repo/entities; seeded here and parity-tested. Ids are the contract — never renumber.'
  `.execute(db);
  await sql`
    INSERT INTO reference.stage_status (stage_status_id, name) VALUES
      (1, 'pending'), (2, 'in_progress'), (3, 'completed'), (4, 'failed')
  `.execute(db);

  // -----------------------------------------------------------------------------------------
  // reference.branch_status
  // -----------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE reference.branch_status (
      branch_status_id integer NOT NULL,
      name             text    NOT NULL,
      CONSTRAINT pk_branch_status PRIMARY KEY (branch_status_id),
      CONSTRAINT uq_branch_status__name UNIQUE (name)
    )
  `.execute(db);
  await sql`
    COMMENT ON TABLE reference.branch_status IS
      'Fan-out branch lifecycle (ADR-0011). Source: BRANCH_STATUS in @repo/entities; seeded here and parity-tested. Ids are the contract — never renumber.'
  `.execute(db);
  await sql`
    INSERT INTO reference.branch_status (branch_status_id, name) VALUES
      (1, 'pending'), (2, 'completed'), (3, 'failed')
  `.execute(db);

  // -----------------------------------------------------------------------------------------
  // reference.branch_kind
  // -----------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE reference.branch_kind (
      branch_kind_id integer NOT NULL,
      name           text    NOT NULL,
      CONSTRAINT pk_branch_kind PRIMARY KEY (branch_kind_id),
      CONSTRAINT uq_branch_kind__name UNIQUE (name)
    )
  `.execute(db);
  await sql`
    COMMENT ON TABLE reference.branch_kind IS
      'Branch drive mechanism (ADR-0011): owned branches are redriven by the reconciler, delegated branches are only aged toward the same uniform ceiling (ADR-0007). Source: BRANCH_KIND in @repo/entities; seeded here and parity-tested.'
  `.execute(db);
  await sql`
    INSERT INTO reference.branch_kind (branch_kind_id, name) VALUES
      (1, 'owned'), (2, 'delegated')
  `.execute(db);

  // -----------------------------------------------------------------------------------------
  // reference.outbox_row_status
  // -----------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE reference.outbox_row_status (
      outbox_row_status_id integer NOT NULL,
      name                  text    NOT NULL,
      CONSTRAINT pk_outbox_row_status PRIMARY KEY (outbox_row_status_id),
      CONSTRAINT uq_outbox_row_status__name UNIQUE (name)
    )
  `.execute(db);
  await sql`
    COMMENT ON TABLE reference.outbox_row_status IS
      'Outbox row lifecycle (ADR-0007): the status column is truth, processed_at is evidence — never filter on the timestamp. Source: OUTBOX_ROW_STATUS in @repo/entities; seeded here and parity-tested.'
  `.execute(db);
  await sql`
    INSERT INTO reference.outbox_row_status (outbox_row_status_id, name) VALUES
      (1, 'pending'), (2, 'processed'), (3, 'dead')
  `.execute(db);

  // -----------------------------------------------------------------------------------------
  // jobs.dead_letter
  // -----------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE jobs.dead_letter (
      dead_letter_id bigserial NOT NULL,
      pipeline       text NOT NULL,
      instance_id    uuid NOT NULL,
      stage          text NOT NULL,
      branch_key     text,
      reason         text NOT NULL,
      attempts       integer NOT NULL,
      payload        jsonb,
      created_at     timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_dead_letter PRIMARY KEY (dead_letter_id),
      CONSTRAINT uq_dead_letter__pipeline_instance_id_stage_branch_key
        UNIQUE NULLS NOT DISTINCT (pipeline, instance_id, stage, branch_key),
      CONSTRAINT ck_dead_letter__reason_not_empty CHECK (reason <> ''),
      CONSTRAINT ck_dead_letter__attempts_non_negative CHECK (attempts >= 0)
    )
  `.execute(db);
  await sql`
    CREATE INDEX ix_dead_letter__created_at ON jobs.dead_letter (created_at DESC)
  `.execute(db);
  // Pipeline-scoped, created_at-ordered index that `purgeDeadLetters`
  // (`packages/jobs/src/retention.ts`) needs: its per-pass batched delete filters
  // `WHERE pipeline = $1 AND created_at < $2 LIMIT n`, which the created_at-only index above
  // cannot serve on its own. `jobs.dead_letter` is one shared cross-pipeline table, so without a
  // pipeline-leading index every pipeline's retention pass would scan every pipeline's rows on
  // each batch iteration — a cost that grows with total system dead-letter volume, not just the
  // purging pipeline's own.
  await sql`
    CREATE INDEX ix_dead_letter__pipeline_created_at ON jobs.dead_letter (pipeline, created_at)
  `.execute(db);
  await sql`
    COMMENT ON TABLE jobs.dead_letter IS
      'The ops-facing incident record (ADR-0007). One shared cross-pipeline table: one place to look, one alert. Rows are written once and never updated.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN jobs.dead_letter.branch_key IS
      'NULL means the dead letter is against the stage itself rather than one of its branches. The unique constraint is NULLS NOT DISTINCT so that NULL collides with NULL and ON CONFLICT DO NOTHING stays replay-safe.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN jobs.dead_letter.pipeline IS
      'Open set, not a reference vocabulary (ADR-0011): every new pipeline adds a value, so a FK here would make declaring a pipeline a migration.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN jobs.dead_letter.payload IS
      'Identifiers and classification ONLY — never user-submitted or provider-returned content (ADR-0006). This table is cross-schema and can never cascade (ADR-0011), so once the owning row is erased, an ids-only row is anonymous. Content wanted beside a dead letter goes in the owning context''s own schema with a cascade FK, referenced from here by id.'
  `.execute(db);
}

/** Local development only (ADR-0003): production rollback is roll-forward + pre-migration dump. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP INDEX jobs.ix_dead_letter__pipeline_created_at`.execute(db);
  await sql`DROP TABLE jobs.dead_letter`.execute(db);
  await sql`DROP TABLE reference.outbox_row_status`.execute(db);
  await sql`DROP TABLE reference.branch_kind`.execute(db);
  await sql`DROP TABLE reference.branch_status`.execute(db);
  await sql`DROP TABLE reference.stage_status`.execute(db);
  await sql`DROP SCHEMA jobs`.execute(db);
}
