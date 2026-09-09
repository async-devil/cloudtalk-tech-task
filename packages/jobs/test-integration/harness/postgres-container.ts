/**
 * Testcontainers `postgres:18` ('s own image choice) for jobs' package-local helper-level
 * proofs (claim/regression-guard/write-ahead-conflict/completeBranch-count and friends —
 * last paragraph). Docker-host autodetect duplicated (not imported) from
 * `apps/api/test/harness/containers.ts` / `packages/messaging/test-integration/harness/redis-container.ts`
 * per that spec's own note on the messaging harness: lifting it into a shared location would
 * add a new workspace edge for a ~30-line block. See those files for the full colima/Ryuk
 * reasoning (registry pitfall, docs/trusted-code-sources.md row 85).
 *
 * Runs the real product migrations (the single `packages/persistence/migrations` folder, since the
 * 2026-07-24 consolidation) via `runMigrations`, THEN layers one test-only fixture schema
 * (`test_pipeline`) that instantiates the table templates by hand — this package
 * owns no domain pipeline table of its own (that is every consuming context's job,
 * `packages/example-context` at), so the helper-level proofs need a stand-in shaped exactly
 * like the frozen templates.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createDb, destroyDb, runMigrations } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import { GenericContainer, Wait } from 'testcontainers';

function autodetectDockerHost(): void {
  if (process.env.DOCKER_HOST !== undefined) {
    return;
  }
  const profile = process.env.COLIMA_PROFILE ?? 'default';
  const colimaSocket = `${homedir()}/.colima/${profile}/docker.sock`;
  if (!existsSync(colimaSocket)) {
    return;
  }
  process.env.DOCKER_HOST = `unix://${colimaSocket}`;
  if (process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE === undefined) {
    process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = '/var/run/docker.sock';
  }
}

// Since the 2026-07-24 consolidation every migration lives in the single
// `packages/persistence/migrations/` folder, so this runs the whole product schema — including
// `example_context`, whose presence `0006-grant-application-roles.ts` requires (it grants on that
// schema). The extra schemas are inert for this package's helper-level proofs, which drive their
// own `test_pipeline` fixture schema.
const MIGRATION_FOLDERS = [
  fileURLToPath(new URL('../../../persistence/migrations', import.meta.url)),
];

/**
 * Test-only root-migration application: the runner skips index `0`
 * (ADR-0011 — provisioning applies it), and a Testcontainers database is empty by
 * construction and single-use, so this harness IS the provisioning step. Runs the real root
 * file's `up` (never a copy), then grants the two roles to the container login role —
 * `SET LOCAL ROLE` requires membership, and the login role's name is deployment configuration a
 * migration cannot parameterize over. Duplicated per harness, not shared, per the
 * same ruling as `autodetectDockerHost` above.
 */
async function applyClusterProvisioning(db: Kysely<unknown>): Promise<void> {
  const rootMigrationPath = fileURLToPath(
    new URL('../../../persistence/migrations/0-create-cluster-roles.ts', import.meta.url),
  );
  const rootMigration = (await import(pathToFileURL(rootMigrationPath).href)) as {
    up: (db: Kysely<unknown>) => Promise<void>;
  };
  await rootMigration.up(db);
  await sql`GRANT app_request, app_worker TO postgres`.execute(db);
}

/** The test-only fixture pipeline: schema `test_pipeline`, table `widget`, two stages
 * (`stage_a`, `stage_b`), shaped exactly like 's frozen templates. Not a real
 * migration (ADR-0006 owner-only DDL governs shipped product tables, not test fixtures). */
export const FIXTURE_CONTRACT = {
  pipeline: 'widget',
  schema: 'test_pipeline',
  table: 'widget',
  instanceIdColumn: 'widget_id',
  stages: ['stage_a', 'stage_b'],
} as const;

export const FIXTURE_OUTBOX = { schema: 'test_pipeline', table: 'outbox' } as const;

async function createFixtureSchema(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE SCHEMA test_pipeline`.execute(db);

  await sql`
    CREATE TABLE test_pipeline.widget (
      widget_id uuid NOT NULL DEFAULT gen_random_uuid(),
      stage_a_stage_status_id integer NOT NULL DEFAULT 1,
      stage_a_attempts integer NOT NULL DEFAULT 0,
      stage_a_updated_at timestamptz NOT NULL DEFAULT now(),
      stage_b_stage_status_id integer NOT NULL DEFAULT 1,
      stage_b_attempts integer NOT NULL DEFAULT 0,
      stage_b_updated_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_widget PRIMARY KEY (widget_id),
      CONSTRAINT fk_widget__stage_status__stage_a FOREIGN KEY (stage_a_stage_status_id)
        REFERENCES reference.stage_status (stage_status_id),
      CONSTRAINT fk_widget__stage_status__stage_b FOREIGN KEY (stage_b_stage_status_id)
        REFERENCES reference.stage_status (stage_status_id)
    )
  `.execute(db);

  await sql`
    CREATE TABLE test_pipeline.widget_stage_result (
      widget_id uuid NOT NULL,
      attempt_token text NOT NULL,
      result jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_widget_stage_result PRIMARY KEY (widget_id, attempt_token),
      CONSTRAINT fk_widget_stage_result__widget FOREIGN KEY (widget_id)
        REFERENCES test_pipeline.widget (widget_id) ON DELETE CASCADE
    )
  `.execute(db);

  await sql`
    CREATE TABLE test_pipeline.widget_branch (
      widget_id uuid NOT NULL,
      stage text NOT NULL,
      branch_key text NOT NULL,
      branch_kind_id integer NOT NULL,
      branch_status_id integer NOT NULL DEFAULT 1,
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT pk_widget_branch PRIMARY KEY (widget_id, stage, branch_key),
      CONSTRAINT fk_widget_branch__widget FOREIGN KEY (widget_id)
        REFERENCES test_pipeline.widget (widget_id) ON DELETE CASCADE,
      CONSTRAINT fk_widget_branch__branch_kind FOREIGN KEY (branch_kind_id)
        REFERENCES reference.branch_kind (branch_kind_id),
      CONSTRAINT fk_widget_branch__branch_status FOREIGN KEY (branch_status_id)
        REFERENCES reference.branch_status (branch_status_id)
    )
  `.execute(db);
  await sql`
    CREATE TRIGGER tg_widget_branch__set_updated_at
      BEFORE UPDATE ON test_pipeline.widget_branch
      FOR EACH ROW EXECUTE FUNCTION persistence.set_updated_at()
  `.execute(db);

  await sql`
    CREATE TABLE test_pipeline.outbox (
      outbox_id bigserial NOT NULL,
      aggregate_id text NOT NULL,
      op text NOT NULL,
      payload jsonb NOT NULL,
      attempts integer NOT NULL DEFAULT 0,
      last_error text,
      outbox_row_status_id integer NOT NULL DEFAULT 1,
      created_at timestamptz NOT NULL DEFAULT now(),
      processed_at timestamptz,
      CONSTRAINT pk_outbox PRIMARY KEY (outbox_id),
      CONSTRAINT fk_outbox__outbox_row_status FOREIGN KEY (outbox_row_status_id)
        REFERENCES reference.outbox_row_status (outbox_row_status_id)
    )
  `.execute(db);
}

export interface JobsTestInfra {
  readonly postgresUrl: string;
  readonly db: Kysely<unknown>;
  stop(): Promise<void>;
}

/** Starts `postgres:18` once per suite file, runs the real migrations, layers the test fixture
 * schema, and returns a ready `Kysely<unknown>` handle plus teardown. */
export async function startJobsTestInfra(): Promise<JobsTestInfra> {
  autodetectDockerHost();

  const postgres = await new GenericContainer('postgres:18')
    .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'jobs_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();

  const postgresUrl = `postgres://postgres:test@${postgres.getHost()}:${postgres.getMappedPort(5432)}/jobs_test`;

  const probe = createDb<unknown>({ connectionString: postgresUrl, poolSize: 1 });
  try {
    let connected = false;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      try {
        await sql`select 1`.execute(probe);
        connected = true;
        break;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, Math.min(attempt * 300, 2_000)));
      }
    }
    if (!connected) {
      throw new Error(
        `jobs test infra: postgres never accepted a connection: ${String(lastError)}`,
      );
    }
    await applyClusterProvisioning(probe);
  } finally {
    await destroyDb(probe);
  }

  const migration = await runMigrations({
    ownerConnectionString: postgresUrl,
    migrationFolders: MIGRATION_FOLDERS,
  });
  if (migration.error !== undefined) {
    const cause = migration.error.cause;
    const causeDetail =
      cause instanceof AggregateError
        ? cause.errors.map((sub) => String(sub)).join('; ')
        : String(cause);
    throw new Error(
      `jobs test infra: migration failed at "${migration.error.migration}": ${causeDetail}`,
    );
  }

  const db = createDb<unknown>({ connectionString: postgresUrl, poolSize: 5 });
  await createFixtureSchema(db);

  return {
    postgresUrl,
    db,
    async stop(): Promise<void> {
      await destroyDb(db);
      await postgres.stop();
    },
  };
}
