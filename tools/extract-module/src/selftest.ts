/**
 * Self-test for `tools/extract-module` (ADR-0001 point 3), mirroring the tier-tooling convention
 * used elsewhere in `tools/arch-checks`: plain outcome array, no vitest — `layer: tool` packages
 * don't inherit the library/application task templates, so this repo's tools ship a hand-written
 * `src/selftest.ts` instead.
 *
 * Two kinds of proof live here, deliberately in one file rather than split across a fixture-level
 * script and a separate live-workspace task:
 *
 * 1. The PURE/fixture-level logic (moon.yml tag parsing, workspace discovery, the dependency
 *    closure's topological order, the package.json/tsconfig rewrites, the build-only extraction
 *    mode) — fast, no network, no `bun install`.
 * 2. The extraction proof's own proof: a real `extractModule()` run against
 *    `test/fixtures/undeclared-import/`'s `fixture-consumer`, which imports a real sibling
 *    package it never declares as a `workspace:*` dependency, and MUST fail. An undeclared import
 *    that quietly built anyway would make the whole tool's central claim — "only declared
 *    dependencies travel" — untestable from the outside, so this is the one case that has to run
 *    for real (`bun install` + `tsc`) rather than being reasoned about in memory.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  copiedTreeHasUnitTests,
  extractionModeOf,
  extractModule,
  rewritePackageJsonForExtraction,
  rewriteTsconfigForExtraction,
  transitiveClosureInBuildOrder,
} from './extract.js';
import {
  changedFolderName,
  changedFolderNames,
  isGlobalExtractionInput,
} from './extract-changed.js';
import {
  discoverWorkspace,
  indexByPackageName,
  liftablePackages,
  parseMoonYamlTags,
  type WorkspacePackage,
} from './workspace.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(SCRIPT_DIR, '..', 'test', 'fixtures');

interface Outcome {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

function outcome(name: string, pass: boolean, detail: string): Outcome {
  return { name, pass, detail };
}

function setsEqual(actual: ReadonlySet<string>, expected: ReadonlyArray<string>): boolean {
  return actual.size === expected.length && expected.every((value) => actual.has(value));
}

// -----------------------------------------------------------------------------------------------
// parseMoonYamlTags
// -----------------------------------------------------------------------------------------------

function testParseMoonYamlTags(outcomes: Outcome[]): void {
  const bare = parseMoonYamlTags(path.join(FIXTURES_DIR, 'moon-yml/bare-tags.yml'));
  outcomes.push(
    outcome(
      'parseMoonYamlTags: bare (unquoted) tags',
      setsEqual(bare, ['tier-capability', 'liftable']),
      `got: ${JSON.stringify([...bare])}`,
    ),
  );

  // A real regression shape: a moon.yml that quotes its tags while most others in the repo write
  // them bare — the original parser kept the quote characters as part of the tag string, so
  // `tags.has('liftable')` silently failed and `--all` skipped the package with no error, just
  // one fewer package in a printed count nobody was watching closely.
  const singleQuoted = parseMoonYamlTags(
    path.join(FIXTURES_DIR, 'moon-yml/single-quoted-tags.yml'),
  );
  outcomes.push(
    outcome(
      'parseMoonYamlTags: single-quoted tags (a quoted-moon.yml regression shape)',
      setsEqual(singleQuoted, ['tier-facade', 'liftable']),
      `got: ${JSON.stringify([...singleQuoted])}`,
    ),
  );

  const doubleQuoted = parseMoonYamlTags(
    path.join(FIXTURES_DIR, 'moon-yml/double-quoted-tags.yml'),
  );
  outcomes.push(
    outcome(
      'parseMoonYamlTags: double-quoted tags',
      setsEqual(doubleQuoted, ['tier-facade', 'liftable']),
      `got: ${JSON.stringify([...doubleQuoted])}`,
    ),
  );

  const noTagsBlock = parseMoonYamlTags(path.join(FIXTURES_DIR, 'moon-yml/no-tags-block.yml'));
  outcomes.push(
    outcome(
      'parseMoonYamlTags: no tags: block at all',
      noTagsBlock.size === 0,
      `got: ${JSON.stringify([...noTagsBlock])}`,
    ),
  );

  const missingFile = parseMoonYamlTags(path.join(FIXTURES_DIR, 'moon-yml/does-not-exist.yml'));
  outcomes.push(
    outcome(
      'parseMoonYamlTags: missing file falls back to empty (not a throw)',
      missingFile.size === 0,
      `got: ${JSON.stringify([...missingFile])}`,
    ),
  );
}

// -----------------------------------------------------------------------------------------------
// discoverWorkspace / indexByPackageName / liftablePackages
// -----------------------------------------------------------------------------------------------

function testDiscoverWorkspace(outcomes: Outcome[]): void {
  const fixtureRepoRoot = path.join(FIXTURES_DIR, 'workspace');
  const packages = discoverWorkspace(fixtureRepoRoot);

  outcomes.push(
    outcome(
      'discoverWorkspace: finds every package with a package.json, skips the one without',
      packages.size === 3 && !packages.has('pkg-d-no-package-json'),
      `got folders: ${JSON.stringify([...packages.keys()])}`,
    ),
  );

  const pkgB = packages.get('pkg-b');
  outcomes.push(
    outcome(
      'discoverWorkspace: pkg-b declares a workspace:* dependency on @repo/pkg-a',
      pkgB !== undefined && setsEqual(pkgB.workspaceDependencyNames, ['@repo/pkg-a']),
      `got: ${JSON.stringify(pkgB && [...pkgB.workspaceDependencyNames])}`,
    ),
  );

  const pkgC = packages.get('pkg-c');
  outcomes.push(
    outcome(
      'discoverWorkspace: pkg-c (tools/, tier-tooling) is discovered but not tagged liftable',
      pkgC !== undefined && !pkgC.tags.has('liftable'),
      `got tags: ${JSON.stringify(pkgC && [...pkgC.tags])}`,
    ),
  );

  const byName = indexByPackageName(packages);
  outcomes.push(
    outcome(
      'indexByPackageName: resolves "@repo/pkg-a" back to the pkg-a folder',
      byName.get('@repo/pkg-a')?.folderName === 'pkg-a',
      `got: ${byName.get('@repo/pkg-a')?.folderName}`,
    ),
  );

  const liftable = liftablePackages(packages)
    .map((pkg) => pkg.folderName)
    .sort();
  outcomes.push(
    outcome(
      'liftablePackages: exactly pkg-a and pkg-b (pkg-c is tier-tooling, no liftable tag)',
      JSON.stringify(liftable) === JSON.stringify(['pkg-a', 'pkg-b']),
      `got: ${JSON.stringify(liftable)}`,
    ),
  );
}

// -----------------------------------------------------------------------------------------------
// transitiveClosureInBuildOrder
// -----------------------------------------------------------------------------------------------

function fixturePackage(
  folderName: string,
  workspaceDependencyNames: ReadonlyArray<string>,
): WorkspacePackage {
  return {
    name: `@repo/${folderName}`,
    folderName,
    dir: `/fixture/packages/${folderName}`,
    relativeDir: `packages/${folderName}`,
    tags: new Set(['liftable']),
    workspaceDependencyNames: new Set(workspaceDependencyNames),
  };
}

function testTransitiveClosureInBuildOrder(outcomes: Outcome[]): void {
  // Diamond: d -> {b, c}, b -> a, c -> a. "a" must build before b/c; both b and c must build
  // before d; d is the closure's root and therefore always last.
  const a = fixturePackage('a', []);
  const b = fixturePackage('b', ['@repo/a']);
  const c = fixturePackage('c', ['@repo/a']);
  const d = fixturePackage('d', ['@repo/b', '@repo/c']);
  const byPackageName = new Map([
    [a.name, a],
    [b.name, b],
    [c.name, c],
    [d.name, d],
  ]);

  const order = transitiveClosureInBuildOrder(d, byPackageName).map((pkg) => pkg.folderName);
  const aIndex = order.indexOf('a');
  const bIndex = order.indexOf('b');
  const cIndex = order.indexOf('c');
  const dIndex = order.indexOf('d');
  const valid =
    order.length === 4 &&
    aIndex < bIndex &&
    aIndex < cIndex &&
    bIndex < dIndex &&
    cIndex < dIndex &&
    dIndex === order.length - 1;
  outcomes.push(
    outcome(
      'transitiveClosureInBuildOrder: diamond graph — every dependency precedes its dependents, root last',
      valid,
      `got order: ${JSON.stringify(order)}`,
    ),
  );

  const singleNodeOrder = transitiveClosureInBuildOrder(a, byPackageName).map(
    (pkg) => pkg.folderName,
  );
  outcomes.push(
    outcome(
      'transitiveClosureInBuildOrder: a package with no workspace deps closes over itself only',
      JSON.stringify(singleNodeOrder) === JSON.stringify(['a']),
      `got: ${JSON.stringify(singleNodeOrder)}`,
    ),
  );

  const orphan = fixturePackage('orphan', ['@repo/does-not-exist']);
  let threw = false;
  let threwUnresolvedMessage = false;
  try {
    transitiveClosureInBuildOrder(orphan, new Map([[orphan.name, orphan]]));
  } catch (error) {
    threw = true;
    threwUnresolvedMessage = error instanceof Error && error.message.includes('does-not-exist');
  }
  outcomes.push(
    outcome(
      'transitiveClosureInBuildOrder: a workspace:* dependency nothing declares throws, names the culprit',
      threw && threwUnresolvedMessage,
      threw ? 'threw, but message did not name the unresolved package' : 'did not throw',
    ),
  );
}

// -----------------------------------------------------------------------------------------------
// rewritePackageJsonForExtraction / rewriteTsconfigForExtraction
// -----------------------------------------------------------------------------------------------

function testRewritePackageJsonForExtraction(outcomes: Outcome[]): void {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'extract-module-selftest-'));
  try {
    writeFileSync(
      path.join(tempDir, 'package.json'),
      JSON.stringify({
        name: '@repo/pkg-b',
        version: '0.0.0',
        dependencies: { '@repo/pkg-a': 'workspace:*', zod: '4.4.3' },
        devDependencies: { vitest: '4.1.10' },
      }),
      'utf8',
    );

    const byPackageName = new Map<string, WorkspacePackage>([
      ['@repo/pkg-a', fixturePackage('pkg-a', [])],
    ]);
    rewritePackageJsonForExtraction(tempDir, byPackageName, '7.0.2');

    const rewritten = JSON.parse(readFileSync(path.join(tempDir, 'package.json'), 'utf8'));
    outcomes.push(
      outcome(
        'rewritePackageJsonForExtraction: workspace:* becomes file:../<folderName>',
        rewritten.dependencies['@repo/pkg-a'] === 'file:../pkg-a',
        `got: ${JSON.stringify(rewritten.dependencies)}`,
      ),
    );
    outcomes.push(
      outcome(
        'rewritePackageJsonForExtraction: a real semver dependency is left untouched',
        rewritten.dependencies.zod === '4.4.3',
        `got: ${rewritten.dependencies.zod}`,
      ),
    );
    outcomes.push(
      outcome(
        'rewritePackageJsonForExtraction: pins typescript into devDependencies',
        rewritten.devDependencies.typescript === '7.0.2',
        `got: ${JSON.stringify(rewritten.devDependencies)}`,
      ),
    );
    outcomes.push(
      outcome(
        'rewritePackageJsonForExtraction: an existing devDependency (vitest) survives the merge',
        rewritten.devDependencies.vitest === '4.1.10',
        `got: ${JSON.stringify(rewritten.devDependencies)}`,
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  const orphanTempDir = mkdtempSync(path.join(os.tmpdir(), 'extract-module-selftest-'));
  try {
    writeFileSync(
      path.join(orphanTempDir, 'package.json'),
      JSON.stringify({
        name: '@repo/orphan',
        version: '0.0.0',
        dependencies: { '@repo/does-not-exist': 'workspace:*' },
      }),
      'utf8',
    );
    let threw = false;
    try {
      rewritePackageJsonForExtraction(orphanTempDir, new Map(), '7.0.2');
    } catch {
      threw = true;
    }
    outcomes.push(
      outcome(
        'rewritePackageJsonForExtraction: an unresolvable workspace:* dependency throws',
        threw,
        threw ? 'threw as expected' : 'did not throw',
      ),
    );
  } finally {
    rmSync(orphanTempDir, { recursive: true, force: true });
  }
}

function testRewriteTsconfigForExtraction(outcomes: Outcome[]): void {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'extract-module-selftest-'));
  try {
    writeFileSync(
      path.join(tempDir, 'tsconfig.json'),
      JSON.stringify({
        extends: '../../tsconfig.base.json',
        compilerOptions: { outDir: 'dist', rootDir: 'src' },
        include: ['src'],
      }),
      'utf8',
    );
    rewriteTsconfigForExtraction(tempDir);
    const rewritten = JSON.parse(readFileSync(path.join(tempDir, 'tsconfig.json'), 'utf8'));
    outcomes.push(
      outcome(
        'rewriteTsconfigForExtraction: two-level extends becomes one level (temp dir is flatter than the repo)',
        rewritten.extends === '../tsconfig.base.json',
        `got: ${rewritten.extends}`,
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  const noTsconfigDir = mkdtempSync(path.join(os.tmpdir(), 'extract-module-selftest-'));
  try {
    let threw = false;
    try {
      rewriteTsconfigForExtraction(noTsconfigDir);
    } catch {
      threw = true;
    }
    outcomes.push(
      outcome(
        'rewriteTsconfigForExtraction: a package with no tsconfig.json is a no-op, not a throw',
        !threw,
        threw ? 'threw unexpectedly' : 'no-op as expected',
      ),
    );
  } finally {
    rmSync(noTsconfigDir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------------------------
// extractionModeOf — the build-only exception's package.json field
// -----------------------------------------------------------------------------------------------

function testExtractionModeOf(outcomes: Outcome[]): void {
  outcomes.push(
    outcome(
      'extractionModeOf: "extraction": "build-only" is read as build-only',
      extractionModeOf({ extraction: 'build-only' }) === 'build-only',
      'expected build-only',
    ),
  );
  outcomes.push(
    outcome(
      'extractionModeOf: an absent field defaults to build-and-test',
      extractionModeOf({}) === 'build-and-test',
      'expected build-and-test',
    ),
  );
  outcomes.push(
    outcome(
      'extractionModeOf: an unrecognized value defaults to build-and-test rather than throwing',
      extractionModeOf({ extraction: 'something-else' }) === 'build-and-test',
      'expected build-and-test',
    ),
  );
}

// -----------------------------------------------------------------------------------------------
// extract-changed: the PR-affected-set mapping
// -----------------------------------------------------------------------------------------------

function testChangedFolderName(outcomes: Outcome[]): void {
  const cases: ReadonlyArray<readonly [string, string | undefined]> = [
    ['packages/jobs/src/stage.ts', 'jobs'],
    ['packages/jobs/package.json', 'jobs'],
    ['tools/extract-module/src/index.ts', 'extract-module'],
    // Apps are ADR-0001's named exception and must never map to an extraction target.
    ['apps/api/src/main.ts', undefined],
    ['apps/app/src/routes/root.tsx', undefined],
    // Root files and docs map to nothing.
    ['docs/adr/ADR-0001-modular-monolith-of-bounded-contexts.md', undefined],
    ['README.md', undefined],
    // A path naming the directory but no file under it is not a package edit.
    ['packages/jobs', undefined],
    // Deceptive prefixes must not match.
    ['packages-legacy/jobs/src/a.ts', undefined],
    ['vendor/packages/jobs/src/a.ts', undefined],
  ];
  for (const [input, expected] of cases) {
    const actual = changedFolderName(input);
    outcomes.push(
      outcome(
        `changedFolderName("${input}") -> ${String(expected)}`,
        actual === expected,
        `got ${String(actual)}`,
      ),
    );
  }
}

function testChangedFolderNames(outcomes: Outcome[]): void {
  const actual = changedFolderNames([
    'packages/jobs/src/a.ts',
    'packages/jobs/src/b.ts',
    'apps/api/src/main.ts',
    'packages/kernel/src/index.ts',
    'docs/x.md',
    'packages/jobs/test/a.test.ts',
  ]);
  outcomes.push(
    outcome(
      'changedFolderNames dedupes and preserves first-seen order',
      actual.length === 2 && actual[0] === 'jobs' && actual[1] === 'kernel',
      `got [${actual.join(', ')}]`,
    ),
  );
  outcomes.push(
    outcome(
      'changedFolderNames of an empty diff is empty',
      changedFolderNames([]).length === 0,
      'expected no candidates',
    ),
  );
}

function testIsGlobalExtractionInput(outcomes: Outcome[]): void {
  const cases: ReadonlyArray<readonly [string, boolean]> = [
    // Copied verbatim into every temp workspace by extract.ts.
    ['tsconfig.base.json', true],
    // The ROOT manifest — extract.ts pins its `typescript` version into every extracted package.
    ['package.json', true],
    // The prover itself.
    ['tools/extract-module/src/extract.ts', true],
    ['tools/extract-module/src/selftest.ts', true],
    // A MODULE's own manifest is that module's business, NOT a global input — if this ever
    // returned true, every ordinary package.json edit would trigger the full liftable matrix.
    ['packages/jobs/package.json', false],
    ['apps/api/package.json', false],
    // A module's own tsconfig, likewise.
    ['packages/jobs/tsconfig.json', false],
    // Other tools are not the prover.
    ['tools/arch-checks/src/run-depcruise.ts', false],
    ['packages/kernel/src/index.ts', false],
    ['docs/adr/ADR-0001-modular-monolith-of-bounded-contexts.md', false],
  ];
  for (const [input, expected] of cases) {
    const actual = isGlobalExtractionInput(input);
    outcomes.push(
      outcome(
        `isGlobalExtractionInput("${input}") -> ${String(expected)}`,
        actual === expected,
        `got ${String(actual)}`,
      ),
    );
  }
}

// -----------------------------------------------------------------------------------------------
// copiedTreeHasUnitTests
//
// `vitest run` exits 0 on "No test files found" unless overridden, so without this predicate an
// extraction whose tests failed to travel would report PASS having asserted nothing. A package
// with no unit suite (yet) legitimately relies on the false branch, so both branches are
// load-bearing.
// -----------------------------------------------------------------------------------------------

function testCopiedTreeHasUnitTests(outcomes: Outcome[]): void {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'extract-selftest-tests-'));
  try {
    const noTestDir = path.join(tempDir, 'no-tests');
    mkdirSync(path.join(noTestDir, 'src'), { recursive: true });
    writeFileSync(path.join(noTestDir, 'src/index.ts'), 'export const a = 1;\n', 'utf8');
    outcomes.push(
      outcome(
        'copiedTreeHasUnitTests is false for a package with no test/ directory',
        !copiedTreeHasUnitTests(noTestDir),
        'expected false (a passWithNoTests: true package with no suite yet)',
      ),
    );

    const emptyTestDir = path.join(tempDir, 'empty-test-dir');
    mkdirSync(path.join(emptyTestDir, 'test'), { recursive: true });
    writeFileSync(path.join(emptyTestDir, 'test/README.md'), 'no tests here\n', 'utf8');
    outcomes.push(
      outcome(
        'copiedTreeHasUnitTests is false for a test/ directory holding no *.test.ts',
        !copiedTreeHasUnitTests(emptyTestDir),
        'expected false',
      ),
    );

    const nestedDir = path.join(tempDir, 'nested');
    mkdirSync(path.join(nestedDir, 'test/unit/deep'), { recursive: true });
    writeFileSync(path.join(nestedDir, 'test/unit/deep/a.test.ts'), '', 'utf8');
    outcomes.push(
      outcome(
        'copiedTreeHasUnitTests finds a nested *.test.ts',
        copiedTreeHasUnitTests(nestedDir),
        'expected true',
      ),
    );

    const tsxDir = path.join(tempDir, 'tsx');
    mkdirSync(path.join(tsxDir, 'test'), { recursive: true });
    writeFileSync(path.join(tsxDir, 'test/a.test.tsx'), '', 'utf8');
    outcomes.push(
      outcome(
        'copiedTreeHasUnitTests recognises *.test.tsx (the styles component-test shape)',
        copiedTreeHasUnitTests(tsxDir),
        'expected true',
      ),
    );

    // test-integration/ is deliberately NOT the unit suite (it needs Docker downstream) and must
    // not make the predicate demand tests vitest was never going to run.
    const integrationOnlyDir = path.join(tempDir, 'integration-only');
    mkdirSync(path.join(integrationOnlyDir, 'test-integration'), { recursive: true });
    writeFileSync(path.join(integrationOnlyDir, 'test-integration/a.test.ts'), '', 'utf8');
    outcomes.push(
      outcome(
        'copiedTreeHasUnitTests ignores test-integration/',
        !copiedTreeHasUnitTests(integrationOnlyDir),
        'expected false',
      ),
    );
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------------------------
// extractModule — the fixture-backed end-to-end proof: an undeclared import must fail the run.
//
// The one case in this file that touches the network (`bun install`) and a real `tsc`/spawned
// process, because the claim under test — "only declared dependencies travel with the copy" — is
// exactly the boundary between the real filesystem/process world and everything else this file
// proves in memory. Left for inspection on failure like any other extraction, via `tempDir`.
// -----------------------------------------------------------------------------------------------

function testUndeclaredImportFailsExtraction(outcomes: Outcome[]): void {
  const fixtureRepoRoot = path.join(FIXTURES_DIR, 'undeclared-import');
  const result = extractModule('fixture-consumer', { repoRoot: fixtureRepoRoot });
  outcomes.push(
    outcome(
      'extractModule: an import of an undeclared sibling workspace package fails the run',
      !result.success,
      result.success
        ? 'extraction unexpectedly PASSED — an undeclared import must fail the run'
        : `failed as expected: ${result.failureDetail ?? '(no detail)'}`,
    ),
  );
}

function main(): number {
  const outcomes: Outcome[] = [];
  testParseMoonYamlTags(outcomes);
  testDiscoverWorkspace(outcomes);
  testTransitiveClosureInBuildOrder(outcomes);
  testRewritePackageJsonForExtraction(outcomes);
  testRewriteTsconfigForExtraction(outcomes);
  testExtractionModeOf(outcomes);
  testChangedFolderName(outcomes);
  testChangedFolderNames(outcomes);
  testIsGlobalExtractionInput(outcomes);
  testCopiedTreeHasUnitTests(outcomes);
  testUndeclaredImportFailsExtraction(outcomes);

  let failures = 0;
  for (const result of outcomes) {
    if (result.pass) {
      console.log(`ok   ${result.name}`);
    } else {
      failures += 1;
      console.error(`FAIL ${result.name} — ${result.detail}`);
    }
  }
  console.log(
    `extract-module-selftest: ${outcomes.length - failures}/${outcomes.length} checks passed.`,
  );
  return failures === 0 ? 0 : 1;
}

process.exit(main());
