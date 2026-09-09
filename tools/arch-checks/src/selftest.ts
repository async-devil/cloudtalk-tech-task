/**
 * The gates' own gate.
 *
 * Every checker here is run twice: once against a fixture tree that satisfies its rule, and once
 * against a tree that deliberately breaks it. A checker that passes the clean fixture proves it
 * does not fire spuriously; a checker that FAILS the violating fixture proves it still fires at
 * all. The second half is the one that matters, and it is the reason this file exists: a rule that
 * silently stopped matching — a renamed directory, a regex that no longer compiles the way it did,
 * an allowlist that widened — looks exactly like a codebase that stopped violating it. Nothing
 * else in the chain can tell those two apart.
 *
 * Run: `bun tools/arch-checks/src/selftest.ts` (the `root:arch-checks-selftest` task).
 *
 * `migration-ddl` is deliberately absent from this list: it ships no fixture tree, and it is
 * exercised against the repository's real migrations by the `root:migration-ddl` task. That is
 * weaker than a red fixture and is recorded here rather than glossed over — a gate with no
 * negative case is a gate nobody has watched fail.
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const FIXTURES = path.join(REPO_ROOT, 'tools/arch-checks/test/fixtures');

interface Case {
  /** The checker script, relative to the repo root. */
  readonly script: string;
  /** Human name, used only in output. */
  readonly gate: string;
  /** Arguments for the run that must PASS. */
  readonly clean: readonly string[];
  /** Arguments for the run that must FAIL. */
  readonly violating: readonly string[];
}

const CASES: readonly Case[] = [
  {
    gate: 'no-core-logging',
    script: 'tools/arch-checks/src/no-core-logging.ts',
    clean: [path.join(FIXTURES, 'no-core-logging/allowed')],
    violating: [path.join(FIXTURES, 'no-core-logging/violation')],
  },
  {
    gate: 'no-cjs-exports-map',
    script: 'tools/arch-checks/src/no-cjs-exports-map.ts',
    clean: [path.join(FIXTURES, 'no-cjs-exports-map/allowed')],
    violating: [path.join(FIXTURES, 'no-cjs-exports-map/violation')],
  },
  {
    gate: 'unjustified-any-gate',
    script: 'tools/arch-checks/src/unjustified-any-gate.ts',
    clean: [path.join(FIXTURES, 'unjustified-any/allowed')],
    violating: [path.join(FIXTURES, 'unjustified-any/violation')],
  },
  {
    gate: 'telemetry-map',
    script: 'tools/arch-checks/src/telemetry-map.ts',
    clean: [path.join(FIXTURES, 'telemetry-map/clean')],
    violating: [path.join(FIXTURES, 'telemetry-map/violations')],
  },
  {
    gate: 'gate-integrity',
    script: 'tools/arch-checks/src/gate-integrity.ts',
    // The clean case is the REAL workflow set and the real manifest: this gate's whole job is to
    // reconcile those two, so a synthetic pair would prove only that the reconciliation runs.
    clean: [
      path.join(REPO_ROOT, '.github/workflows'),
      path.join(REPO_ROOT, 'tools/arch-checks/required-gates.json'),
    ],
    violating: [
      path.join(FIXTURES, 'gate-integrity/missing-job/.github/workflows'),
      path.join(FIXTURES, 'gate-integrity/missing-job/required-gates.json'),
    ],
  },
];

function run(script: string, args: readonly string[]): { code: number; output: string } {
  const result = spawnSync('bun', [path.join(REPO_ROOT, script), ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return {
    code: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

const failures: string[] = [];

for (const testCase of CASES) {
  // A fixture that is not on disk reports as "the gate found nothing", which is indistinguishable
  // from a clean pass. Check the precondition explicitly, so the next time a fixture goes missing
  // the message says so rather than leaving a green run that proved nothing.
  for (const fixtureArg of [...testCase.clean, ...testCase.violating]) {
    if (!existsSync(fixtureArg)) {
      failures.push(`${testCase.gate}: fixture path does not exist: ${fixtureArg}`);
    }
  }

  const clean = run(testCase.script, testCase.clean);
  if (clean.code !== 0) {
    failures.push(
      `${testCase.gate}: reported a violation against its CLEAN fixture (exit ${clean.code})\n${clean.output}`,
    );
  }

  const violating = run(testCase.script, testCase.violating);
  if (violating.code === 0) {
    failures.push(
      `${testCase.gate}: passed its VIOLATING fixture — the rule has stopped matching, which is ` +
        'indistinguishable from a clean repository until something checks',
    );
  }
}

if (failures.length > 0) {
  console.error('arch-checks selftest FAILED:\n');
  for (const failure of failures) console.error(`  - ${failure}\n`);
  process.exit(1);
}

console.log(`arch-checks selftest: ${CASES.length} gates proved on both a clean and a red fixture`);
