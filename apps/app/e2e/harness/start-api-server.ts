/**
 * The Playwright `webServer` command for the api half of the e2e stack ("Vite preview + the api in
 * `APP_MODE=test` against compose services").
 *
 * Brings up `deploy/compose/dev.yml` (Postgres + Redis + otel-lgtm — the dev stack) if it is not
 * already reachable, applies the persistence migrations against it, seeds a realistic catalogue
 * (TASK-0006's `apps/api/src/db/seed.ts` — every spec gets a real product to browse rather than
 * having to create its own fixture data), then spawns the REAL composition root
 * (`apps/api/src/runtime/main.ts`) in `APP_MODE=test` — the exact entry `moon run api:dev` boots,
 * not a hand-rolled stand-in. Every env value the composition root reads is set explicitly below
 * rather than left to its non-live defaults, because some of those defaults are WRONG for this
 * stack specifically (see `RUNTIME_ENV`'s comments).
 *
 * `docker compose` is only invoked when `E2E_DATABASE_URL`/`E2E_REDIS_URL` are unset (i.e. the
 * caller wants the default compose-backed stack this file names): a caller pointing this script at
 * infra it already manages is trusted to have started it, exactly like `DATABASE_URL`/`REDIS_URL`
 * are trusted everywhere else in this codebase (env, not code, selects the backing service).
 *
 * Left running on exit: only the spawned `main.ts` child is stopped when Playwright tears this
 * webServer entry down (SIGTERM/SIGINT forwarded below) — the compose stack itself is left up, the
 * same lifecycle a developer's own `docker compose up -d` has. Re-running the e2e suite locally
 * re-uses the warmed containers and their data instead of paying a fresh pull/init every time.
 */

import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { API_PORT } from '../constants.js';

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url));
const COMPOSE_FILE = `${REPO_ROOT}/deploy/compose/dev.yml`;
const API_MAIN_ENTRY = `${REPO_ROOT}/apps/api/src/runtime/main.ts`;
const API_MIGRATE_ENTRY = `${REPO_ROOT}/apps/api/src/db/migrate.ts`;
const API_SEED_ENTRY = `${REPO_ROOT}/apps/api/src/db/seed.ts`;

/**
 * The compose services this stack actually needs, named rather than left implicit.
 *
 * `deploy/compose/dev.yml` also defines `otel-lgtm` (a ~1GB Grafana image), and bringing up the
 * whole file would pull it. Nothing here needs it: `runtime/main.ts` wires NO network exporter
 * under `APP_MODE=test` (its own step-3 comment), so the collector would sit idle receiving
 * nothing. Naming the two services keeps the local run fast and the `e2e` CI job's cost
 * proportionate to what it proves.
 */
const COMPOSE_SERVICES: readonly string[] = ['postgres', 'redis'];

/** The compose file's own fixed ports and database name (`POSTGRES_PASSWORD:-dev` default). */
const DEFAULT_DATABASE_URL = 'postgres://postgres:dev@localhost:5432/reviews';
const DEFAULT_REDIS_URL = 'redis://localhost:6379';

const databaseUrl = process.env.E2E_DATABASE_URL ?? DEFAULT_DATABASE_URL;
const redisUrl = process.env.E2E_REDIS_URL ?? DEFAULT_REDIS_URL;
const usingComposeDefaults = databaseUrl === DEFAULT_DATABASE_URL && redisUrl === DEFAULT_REDIS_URL;

/** Every env key `apps/api/src/runtime/main.ts` reads, for `APP_MODE=test` (test is lenient; only
 * `DATABASE_URL`/`REDIS_URL` are unconditionally required, everything else below is either a
 * non-default override this stack specifically needs, or spelled out for clarity even where it
 * matches the schema default). */
const RUNTIME_ENV: Record<string, string> = {
  APP_MODE: 'test',
  DATABASE_URL: databaseUrl,
  REDIS_URL: redisUrl,
  PORT: String(API_PORT),
  HOST: '127.0.0.1',
  AUTH_BASE_URL: `http://localhost:${API_PORT}`,
  // The e2e session-mock route (and the real magic-link spec) sign fresh addresses up on first
  // use. `AUTH_SIGNUP_POSTURE`'s non-live default is `allowlist` (closed) — open it explicitly for
  // this stack.
  AUTH_SIGNUP_POSTURE: 'open',
  // The api's own non-live CORS default targets `vite`'s DEV origin (5173, `apps/api/src/config/
  // api-slice.ts`'s `DEV_SPA_ORIGIN`) — this stack serves the built app via `vite preview` (4173),
  // which is a different origin the default does not cover.
  HTTP_CORS_ALLOWED_ORIGINS: 'http://localhost:4173',
};

function runToCompletion(
  command: string,
  args: readonly string[],
  env: Record<string, string> = { PATH: process.env.PATH ?? '' },
): void {
  const result = spawnSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit', env });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${String(result.status)}`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs `apps/api/src/db/migrate.ts` with retries (a container runtime's port-forwarder can still
 * refuse connections for a moment after `docker compose up --wait` reports the container's own
 * healthcheck green — the same window `apps/api/test/harness/containers.ts` documents and probes
 * for with a `select 1` loop; this script gets the same coverage for free by retrying the whole
 * migrate script, which is itself the first real connection attempt).
 */
async function migrateWithRetry(): Promise<void> {
  const maxAttempts = 30;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const isLastAttempt = attempt === maxAttempts;
    const result = spawnSync('bun', [API_MIGRATE_ENTRY], {
      cwd: REPO_ROOT,
      stdio: isLastAttempt ? 'inherit' : 'pipe',
      env: { PATH: process.env.PATH ?? '', APP_MODE: 'test', DATABASE_URL: databaseUrl },
    });
    if (result.status === 0) {
      return;
    }
    if (isLastAttempt) {
      throw new Error(
        `start-api-server: migrate never succeeded after ${String(maxAttempts)} attempts`,
      );
    }
    await sleep(Math.min(attempt * 300, 2_000));
  }
}

async function main(): Promise<void> {
  if (usingComposeDefaults) {
    process.stdout.write(
      `start-api-server: docker compose up -d --wait ${COMPOSE_SERVICES.join(' ')}\n`,
    );
    runToCompletion('docker', [
      'compose',
      '-f',
      COMPOSE_FILE,
      'up',
      '-d',
      '--wait',
      ...COMPOSE_SERVICES,
    ]);
  } else {
    process.stdout.write(
      'start-api-server: E2E_DATABASE_URL/E2E_REDIS_URL override the compose defaults — skipping ' +
        '`docker compose up` and trusting the caller has already started that infra.\n',
    );
  }

  process.stdout.write('start-api-server: migrating\n');
  await migrateWithRetry();

  // Idempotent (TASK-0006: accounts matched by email, products by slug, reviews by natural key) —
  // safe on every invocation, including against this harness's own intentionally-reused warm
  // compose Postgres between local runs. Gives every spec a real catalogue to browse rather than
  // each one having to create its own fixture data from nothing.
  process.stdout.write('start-api-server: seeding\n');
  runToCompletion('bun', [API_SEED_ENTRY], {
    PATH: process.env.PATH ?? '',
    APP_MODE: 'test',
    DATABASE_URL: databaseUrl,
  });

  process.stdout.write('start-api-server: starting api\n');
  const child: ChildProcessWithoutNullStreams = spawn('bun', [API_MAIN_ENTRY], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { PATH: process.env.PATH ?? '', ...RUNTIME_ENV },
  });

  let shuttingDown = false;
  // The two signals actually forwarded, not the whole `NodeJS.Signals` union: this project has no
  // `@types/node` (hand-written ambients only, see `apps/app/node-ambient.d.ts`), so naming the
  // narrow set here is what makes the declaration and the call site agree.
  function forward(signal: 'SIGTERM' | 'SIGINT'): void {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    child.kill(signal);
  }
  process.on('SIGTERM', () => forward('SIGTERM'));
  process.on('SIGINT', () => forward('SIGINT'));

  const exitCode = await new Promise<number>((resolve) => {
    child.on('exit', (code) => resolve(code ?? 0));
  });
  process.exit(exitCode);
}

main().catch((error: unknown) => {
  process.stderr.write(`start-api-server: ${String(error)}\n`);
  process.exit(1);
});
