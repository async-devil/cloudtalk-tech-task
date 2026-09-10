/**
 * The gate that typechecks what `tsc --noEmit` structurally cannot: every package's `test/` and
 * `test-integration/` directories.
 *
 * WHY THIS EXISTS. Each package's own `tsconfig.json` carries `include: ["src"]` with
 * `rootDir: "src"` and `composite: true` — it has to, because that same config drives `build`, and
 * emitting test files into `dist/` would ship them. So the inherited `typecheck` task
 * (`.moon/tasks/all.yml`) never sees a test file. The `test` task runs vitest, which TRANSPILES
 * rather than typechecks. And `test-integration` needs Docker, so on a machine without one that
 * suite does not even execute.
 *
 * The consequence, before this gate: a type error in a container suite was invisible to the entire
 * chain and reached CI as a runtime failure in a file nothing had ever compiled. Not hypothetical —
 * it happened while this repository's reviews context was being built, in the kill-and-restart
 * harness that TASK-0005 calls the justification for ADR-0007's machinery. A suite nobody can
 * compile is a proof nobody can trust.
 *
 * HOW. For each package carrying a `test/` or `test-integration/` directory, this writes a
 * throwaway config that extends the package's own — so every strictness flag in
 * `tsconfig.base.json` still applies — with `composite`/`rootDir`/`outDir` turned off (they exist
 * for the build, and a `noEmit` check neither needs nor can satisfy them) and the test directories
 * added beside `src`. `src` stays included because a test's imports must resolve against the same
 * ambient declarations the module itself sees; a mismatch there is exactly the drift that made
 * this gate necessary.
 *
 * Deliberately scans rather than requiring a committed `tsconfig.tests.json` per package: a config
 * a package must remember to add is a check a package can silently opt out of by forgetting.
 *
 * TWO MODES. From inside a package with no argument it checks that package only — the inherited
 * `typecheck-tests` task's path, so moon schedules it after that package's `^:build` and reports
 * it under the package's own name. With a repo-root argument it sweeps every product package,
 * which is what a human wants when asking "is anything broken anywhere". Both go through
 * `typecheckPackage`, so the sweep can never disagree with the per-package run.
 *
 * CLI: `bun tools/arch-checks/src/typecheck-tests.ts [repoRoot]`.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { PRODUCT_SOURCE_ROOTS } from './workspace-roots.js';

const TEST_DIRECTORIES = ['test', 'test-integration'] as const;

/** This tool's own repository root — where its `tsc` lives, regardless of which tree is scanned. */
const SELF_REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

/** Fixed rather than randomised: it lives in the package directory and is removed in a `finally`,
 * and moon never runs one package's task twice at once. A random suffix would only make a leaked
 * file harder to find. */
const THROWAWAY_CONFIG = '.tsconfig.typecheck-tests.json';

/**
 * Scoped to {@link PRODUCT_SOURCE_ROOTS} (`packages`, `apps`) rather than every workspace folder,
 * following the ruling that file already records: `tools/*` holds verification harnesses, and its
 * `test/fixtures/` trees are DELIBERATELY broken code — a gate's red fixture exists to be
 * rejected. Typechecking those would report each fixture's intended violation as this gate's own
 * failure.
 */
function productPackageDirs(repoRoot: string): readonly string[] {
  const dirs: string[] = [];
  for (const root of PRODUCT_SOURCE_ROOTS) {
    const absolute = path.join(repoRoot, root);
    if (!existsSync(absolute)) {
      continue;
    }
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(path.join(absolute, entry.name, 'package.json'))) {
        dirs.push(`${root}/${entry.name}`);
      }
    }
  }
  return dirs;
}

interface PackageResult {
  /** `false` when the package ships no test directory at all — not a failure, not a pass. */
  readonly checked: boolean;
  /** `tsc`'s output when it failed, absent when it passed. */
  readonly failure?: string;
}

function typecheckPackage(repoRoot: string, packageDir: string): PackageResult {
  const absolute = path.join(repoRoot, packageDir);
  const present = TEST_DIRECTORIES.filter((name) => existsSync(path.join(absolute, name)));
  if (present.length === 0) {
    return { checked: false };
  }
  if (!existsSync(path.join(absolute, 'tsconfig.json'))) {
    return {
      checked: true,
      failure: `${packageDir} has ${present.join('/')} but no tsconfig.json to extend`,
    };
  }

  // Written into the package directory rather than a temp dir: `extends`, `include` and module
  // resolution all resolve relative to the config's OWN location, so a config living elsewhere
  // would resolve every one of them against the wrong root.
  const configPath = path.join(absolute, THROWAWAY_CONFIG);
  writeFileSync(
    configPath,
    JSON.stringify({
      extends: './tsconfig.json',
      compilerOptions: {
        noEmit: true,
        // Off, not overridden: `composite` requires every input to sit under `rootDir`, and the
        // test directories are siblings of `src` by design.
        composite: false,
        rootDir: null,
        outDir: null,
        tsBuildInfoFile: null,
      },
      include: ['src', ...present],
    }),
    'utf8',
  );

  try {
    // `tsc` comes from THIS repository's own `node_modules`, never from `repoRoot`'s. The two are
    // the same for a real run, and different for a fixture tree — which has no `node_modules` at
    // all, so resolving against the scanned root would make this gate untestable by the very
    // self-test that proves it still fires (`selftest.ts`).
    const result = spawnSync(
      path.join(SELF_REPO_ROOT, 'node_modules/.bin/tsc'),
      ['--noEmit', '--project', configPath],
      { cwd: absolute, encoding: 'utf8' },
    );
    if (result.status === 0) {
      return { checked: true };
    }
    return { checked: true, failure: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim() };
  } finally {
    unlinkSync(configPath);
  }
}

const UNCOMPILED_ELSEWHERE =
  'These files are compiled by nothing else in the chain — vitest transpiles rather than ' +
  'typechecks, and a container suite may not even run locally.';

function main(): number {
  const repoRootArgument = process.argv[2];
  const selfRepoRoot = SELF_REPO_ROOT;

  if (repoRootArgument === undefined && path.resolve(process.cwd()) !== selfRepoRoot) {
    const packageDir = path.relative(selfRepoRoot, process.cwd());
    const result = typecheckPackage(selfRepoRoot, packageDir);
    if (result.failure === undefined) {
      console.log(
        result.checked
          ? `typecheck-tests: ${packageDir} test suites typecheck clean.`
          : `typecheck-tests: ${packageDir} ships no test directory — nothing to check.`,
      );
      return 0;
    }
    console.error(`typecheck-tests: ${packageDir}`);
    console.error(result.failure);
    console.error(UNCOMPILED_ELSEWHERE);
    return 1;
  }

  // Resolved, never used as given: `tsc` runs with its cwd set to the package directory and
  // re-resolves a relative `--project` against that cwd, which would double the path.
  const repoRoot = repoRootArgument === undefined ? selfRepoRoot : path.resolve(repoRootArgument);
  const failures: string[] = [];
  let checked = 0;
  for (const packageDir of productPackageDirs(repoRoot)) {
    const result = typecheckPackage(repoRoot, packageDir);
    if (!result.checked) {
      continue;
    }
    checked += 1;
    if (result.failure !== undefined) {
      failures.push(`===== ${packageDir} =====\n${result.failure}`);
    }
  }

  if (failures.length === 0) {
    console.log(`typecheck-tests: ${checked} package test suite(s) typecheck clean.`);
    return 0;
  }
  for (const failure of failures) {
    console.error(failure);
  }
  console.error(
    `typecheck-tests: ${failures.length} of ${checked} package test suite(s) failed to typecheck.`,
  );
  console.error(UNCOMPILED_ELSEWHERE);
  return 1;
}

process.exit(main());
