/**
 * `bun run setup` (TASK-0006, ADR-0005): the one command that takes a clean checkout to a running
 * application. Brings up the compose services this stack needs, applies migrations, seeds a
 * realistic catalogue, starts both dev servers, and reports the URL to open — nothing else is
 * required, and no secrets: `test` mode is what runs, the same tier every other local-dev flow in
 * this repository already documents.
 *
 * A root-level `scripts/` file rather than a `tools/arch-checks/` gate or a `packages/*` module:
 * this is developer-experience tooling with no architectural rule to enforce, the same category
 * `apps/app/scripts/check-route-tree.ts` already occupies for its own app.
 */

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const COMPOSE_FILE = `${REPO_ROOT}/deploy/compose/dev.yml`;
const API_PORT = 3000;
const APP_PORT = 5173;

/** Postgres + Redis only — the same choice `apps/app/e2e/harness/start-api-server.ts` makes and
 * documents: `otel-lgtm`/`otel-collector` are a ~1GB image this command does not need to prove a
 * working application, and `test` mode wires no OTLP exporter at all. */
const COMPOSE_SERVICES: readonly string[] = ['postgres', 'redis'];

const DATABASE_URL = 'postgres://postgres:dev@localhost:5432/reviews';
const REDIS_URL = 'redis://localhost:6379';

/** Every env key the composition root and the migrator need, for `APP_MODE=test` (lenient — only
 * `DATABASE_URL`/`REDIS_URL` are unconditionally required). Mirrors
 * `apps/app/e2e/harness/start-api-server.ts`'s own `RUNTIME_ENV`. */
const RUNTIME_ENV: Record<string, string> = {
  APP_MODE: 'test',
  DATABASE_URL,
  DATABASE_OWNER_URL: DATABASE_URL,
  REDIS_URL,
  PORT: String(API_PORT),
  HOST: '127.0.0.1',
  AUTH_BASE_URL: `http://localhost:${API_PORT}`,
  AUTH_SIGNUP_POSTURE: 'open',
  HTTP_CORS_ALLOWED_ORIGINS: `http://localhost:${APP_PORT}`,
};

function log(message: string): void {
  process.stdout.write(`setup: ${message}\n`);
}

function runToCompletion(command: string, args: readonly string[], env: NodeJS.ProcessEnv): void {
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

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok || response.status < 500) {
        return;
      }
    } catch {
      // Not up yet — retry until the deadline.
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${url}`);
    }
    await sleep(500);
  }
}

/** Spawned detached and `unref`'d so both dev servers keep running once this script's own
 * process exits — the whole point of "one command that ends with a working application" rather
 * than one that ends with the application already gone. */
function spawnDetached(
  command: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
): ChildProcess {
  const child = spawn(command, args, {
    cwd,
    env,
    detached: true,
    stdio: 'inherit',
  });
  child.unref();
  return child;
}

async function main(): Promise<void> {
  const bunExecutable = process.execPath;

  log('installing dependencies');
  runToCompletion('bun', ['install'], process.env);

  log(`starting ${COMPOSE_SERVICES.join(', ')} (docker compose)`);
  runToCompletion(
    'sudo',
    ['docker', 'compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait', ...COMPOSE_SERVICES],
    process.env,
  );

  log('building workspace packages');
  runToCompletion(`${REPO_ROOT}/node_modules/.bin/moon`, ['run', 'app:build', 'api:build'], process.env);

  const env = { ...process.env, ...RUNTIME_ENV };

  log('applying migrations');
  runToCompletion(bunExecutable, ['apps/api/src/db/migrate.ts'], env);

  log('seeding the catalogue');
  runToCompletion(bunExecutable, ['apps/api/src/db/seed.ts'], env);

  log('starting the api (test mode)');
  spawnDetached(bunExecutable, ['apps/api/src/runtime/main.ts'], REPO_ROOT, env);
  await waitForHttp(`http://localhost:${API_PORT}/health`, 30_000);

  log('starting the app');
  spawnDetached(bunExecutable, ['run', 'dev'], `${REPO_ROOT}/apps/app`, env);
  await waitForHttp(`http://localhost:${APP_PORT}`, 30_000);

  log('done');
  process.stdout.write(`\nOpen http://localhost:${APP_PORT}\n`);
  process.stdout.write(
    'Sign-in is a magic link; in test mode the link is printed to the api log.\n',
  );
  process.stdout.write(
    'Seeded accounts: manager@example.test (catalogue manager), moderator@example.test (moderator).\n',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`setup: ${String(error)}\n`);
  process.exit(1);
});
