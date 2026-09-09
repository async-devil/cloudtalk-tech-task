/**
 * Testcontainers `postgres:18` for TASK-0002's container-only acceptance criteria: the
 * outbox invariant on `submitReview`, idempotent replay, and the drop-and-rebuild proof for
 * `reviews.product_rating`. Docker-host autodetect duplicated (not imported) from
 * `packages/jobs/test-integration/harness/postgres-container.ts` /
 * `packages/messaging/test-integration/harness/redis-container.ts` / `apps/api/test/harness/
 * containers.ts` — per those files' own note: lifting a ~30-line block into a shared location
 * would add a new workspace edge for it, and this package has as little reason to depend on
 * `jobs`'/`messaging`'s test harnesses as they have to depend on this one's. See those files for
 * the full colima/Ryuk reasoning (registry pitfall, docs/trusted-code-sources.md row 85).
 *
 * Runs the real product migrations (the single `packages/persistence/migrations` folder) via
 * `runMigrations` — the whole schema, `reviews` included, since `reviews.review` references
 * `auth.app_user` (`0003-create-auth.ts`) and both are on the one global migration index
 * (SPEC-0002). No fixture schema is layered on top the way jobs' harness layers `test_pipeline`:
 * this context owns real tables of its own, and the two fixtures below (`createAppUser`,
 * `createTestProduct`) build rows in THOSE tables through the real write paths rather than a
 * stand-in.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { mintToken, PRODUCT_CATEGORY, TOKEN_PREFIX } from '@repo/entities';
import { createDb, destroyDb, runMigrations } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import { GenericContainer, Wait } from 'testcontainers';
import { type CreateProductInput, createProduct, type ProductRecord } from '../../src/index.js';

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

// Every migration lives in the single `packages/persistence/migrations/` folder (currently
// `0001`-`0004`: persistence bootstrap, the jobs spine, auth, reviews), so this runs the whole
// product schema — this package's suites need `auth.app_user` (0003) as much as they need
// `reviews.*` (0004).
const MIGRATION_FOLDERS = [
  fileURLToPath(new URL('../../../persistence/migrations', import.meta.url)),
];

export interface ReviewsTestInfra {
  readonly postgresUrl: string;
  readonly db: Kysely<unknown>;
  stop(): Promise<void>;
}

/** Starts `postgres:18` once per suite file and runs the real migrations, returning a ready
 * `Kysely<unknown>` handle plus teardown. Isolation between tests is by generating fresh ids
 * (see `createAppUser`/`createTestProduct` below), never by truncating — matching
 * `packages/jobs/test-integration`'s own suite skeleton. */
export async function startReviewsTestInfra(): Promise<ReviewsTestInfra> {
  autodetectDockerHost();

  const postgres = await new GenericContainer('postgres:18')
    .withEnvironment({ POSTGRES_PASSWORD: 'test', POSTGRES_DB: 'reviews_test' })
    .withExposedPorts(5432)
    .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
    .withStartupTimeout(120_000)
    .start();

  const postgresUrl = `postgres://postgres:test@${postgres.getHost()}:${postgres.getMappedPort(5432)}/reviews_test`;

  // Wait-strategy readiness (`forLogMessage` above) proves the SERVER logged "ready", not that
  // this process can already reach it — a fresh connection can still race the log line by a beat.
  // No cluster-role provisioning step belongs here: `0002-create-jobs-spine.ts` states this
  // repository's actual role model plainly — "no RLS-scoped runtime roles — one connection owns
  // both migrations and runtime traffic" — and the container's `postgres` login role is already
  // that connection's superuser, so `runMigrations` below needs nothing granted to it first.
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
        `reviews test infra: postgres never accepted a connection: ${String(lastError)}`,
      );
    }
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
      `reviews test infra: migration failed at "${migration.error.migration}": ${causeDetail}`,
    );
  }

  const db = createDb<unknown>({ connectionString: postgresUrl, poolSize: 5 });

  return {
    postgresUrl,
    db,
    async stop(): Promise<void> {
      await destroyDb(db);
      await postgres.stop();
    },
  };
}

// -------------------------------------------------------------------------------------------
// Fixtures. `reviews.review.author_id` references `auth.app_user(app_user_id)` (0003), and every
// write path this package tests takes a `productSlug`/`authorId` that must already exist — both
// fixtures below build those rows through the real write paths (a raw INSERT for the auth rows
// this package does not own, `createProduct` itself for products), never by hand-shaping a row
// this package's own pipeline would never produce.
// -------------------------------------------------------------------------------------------

let fixtureSequence = 0;

/** A short unique lowercase-hex tag, synchronous per call so concurrent fixture creation (e.g.
 * inside `Promise.all`) never races two calls onto the same suffix. */
function uniqueTag(): string {
  fixtureSequence += 1;
  return `${crypto.randomUUID().replace(/-/g, '').slice(0, 10)}${fixtureSequence}`;
}

/**
 * Inserts an `auth.identity` row and its `auth.app_user` row (0003-create-auth.ts) and returns
 * the app-owned `app_user_id` — the id `reviews.review.author_id` references, never
 * `auth.identity.id` (SPEC-0002). A fresh, uniquely-emailed identity per call: test isolation by
 * generating fresh rows, never by truncating.
 */
export async function createAppUser(db: Kysely<unknown>): Promise<string> {
  const tag = uniqueTag();
  const identityResult = await sql`
    INSERT INTO auth.identity (name, email)
    VALUES (${`Test User ${tag}`}, ${`test-user-${tag}@example.test`})
    RETURNING id
  `.execute(db);
  const identityId = (identityResult.rows[0] as { id: string }).id;

  const appUserResult = await sql`
    INSERT INTO auth.app_user (identity_id, token)
    VALUES (${identityId}, ${mintToken(TOKEN_PREFIX.User)})
    RETURNING app_user_id
  `.execute(db);
  return (appUserResult.rows[0] as { app_user_id: string }).app_user_id;
}

export type TestProductOverrides = Partial<CreateProductInput>;

/** `createTestProduct`'s return shape: the module's own public `ProductRecord` plus the internal
 * `productId` most suites need for a raw follow-up query (`reviews.product_rating` is keyed by
 * it, `reviews.outbox.aggregate_id` carries it) — ADR-0016 keeps `productId` out of
 * `ProductRecord` itself, so it is added here rather than smuggled into the public type. */
export interface TestProduct extends ProductRecord {
  readonly productId: string;
}

/**
 * Calls the module's OWN `createProduct` (`../../src/index.js`) so every fixture product goes
 * through the real pipeline — never a hand-built `INSERT` that could drift from what the pipeline
 * actually writes. Every field defaults to a fresh, constraint-satisfying value (`slug`/`sku` are
 * both uniquely tagged, so two calls never collide with each other); `overrides` replaces
 * individual fields, e.g. `createTestProduct(db, { slug: existing.slug })` to deliberately force a
 * slug collision.
 */
export async function createTestProduct(
  db: Kysely<unknown>,
  overrides: TestProductOverrides = {},
): Promise<TestProduct> {
  const tag = uniqueTag();
  const input: CreateProductInput = {
    slug: overrides.slug ?? `test-product-${tag}`,
    sku: overrides.sku ?? `TEST-${tag.toUpperCase()}`,
    name: overrides.name ?? 'Integration Test Product',
    description: overrides.description ?? 'A product created by the reviews integration harness.',
    categoryName: overrides.categoryName ?? PRODUCT_CATEGORY.Audio.name,
    priceMinor: overrides.priceMinor ?? 1999,
    currencyCode: overrides.currencyCode ?? 'USD',
  };
  const record = await createProduct(db, input);
  const idResult = await sql`
    SELECT product_id FROM reviews.product WHERE slug = ${record.slug}
  `.execute(db);
  const productId = (idResult.rows[0] as { product_id: string }).product_id;
  return { ...record, productId };
}
