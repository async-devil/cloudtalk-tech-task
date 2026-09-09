/**
 * Runs a package's Testcontainers suite, and decides what "no Docker" means.
 *
 * These suites are the durability and security proofs — a worker killed mid-stage, a flushed
 * Redis, a real Postgres round trip. They are the tests worth trusting, and they need a container
 * runtime. A developer without one should still get a green `moon ci` on a fresh clone; CI must
 * never get a green chain that quietly proved none of it.
 *
 * So the two cases are separated explicitly, and the local one is LOUD. Without Docker and without
 * `CI`, this prints what it skipped and exits 0. Without Docker and WITH `CI`, it fails: a
 * container suite that silently did not run is the exact shape of green-but-unproven this
 * repository refuses everywhere else.
 *
 * The suite itself runs on Bun rather than Node, for the same reason `apps/api`'s does — see the
 * header in `apps/api/vitest.config.ts`.
 */

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const projectDir = process.cwd();
const projectName = path.basename(projectDir);

function dockerIsReachable(): boolean {
  // `docker info`, not `docker --version`: the CLI can be installed while no daemon is listening,
  // which is the state that actually breaks the suites. Measured that way rather than assumed.
  const probe = spawnSync('docker', ['info'], { stdio: 'ignore' });
  return probe.status === 0;
}

if (!dockerIsReachable()) {
  if (process.env.CI !== undefined && process.env.CI !== '') {
    console.error(
      `${projectName}:test-integration — Docker is not reachable in CI. These suites are the ` +
        'durability proofs; skipping them here would make the chain green without having proved ' +
        'anything, so this is a hard failure.',
    );
    process.exit(1);
  }
  console.log(
    `${projectName}:test-integration — SKIPPED: no reachable Docker daemon.\n` +
      '  These are the container-backed proofs (real Postgres and Redis). They run in CI, and\n' +
      '  locally as soon as a daemon is up. Nothing about this run has proved them.',
  );
  process.exit(0);
}

const result = spawnSync(
  'bun',
  [
    path.join(REPO_ROOT, 'node_modules/vitest/vitest.mjs'),
    'run',
    '--config',
    'vitest.integration.config.ts',
  ],
  { cwd: projectDir, stdio: 'inherit' },
);

process.exit(result.status ?? 1);
