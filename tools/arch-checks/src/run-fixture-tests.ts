/**
 * Rule self-tests (ADR-0001).
 *
 * Runs the real `../../.dependency-cruiser.cjs` ruleset — unmodified — against every fixture
 * tree in `test/fixtures/`, using dependency-cruiser's documented JS API (`cruise()` +
 * `extractDepcruiseOptions()`, doc/api.md at the pinned v18.1.0). Every `violations/*` fixture
 * must fail with its named rule; every `ok/*` fixture must cruise clean. Exits non-zero on any
 * mismatch, naming the offending fixture(s).
 *
 * Each fixture gets `baseDir` set to its own directory rather than a `process.chdir()` dance:
 * `cruise()`'s `baseDir` option re-roots every reported path (verified empirically by pointing
 * `cruise()` at the same tree from two different `process.cwd()`s and confirming identical
 * output) — so a fixture's own `packages/module-a/src/index.mjs` reports exactly as
 * `packages/module-a/src/index.mjs`, the same shape the real ruleset's regexes assume for the
 * actual repo. No cwd mutation, so fixtures can be run in one process without cross-contaminating
 * each other (run sequentially below anyway, out of caution — dependency-cruiser's internals are
 * not documented as safe for concurrent `cruise()` calls).
 *
 * TypeScript parsing: dependency-cruiser 18.1.0 accepts `typescript >=2 <7` or `@swc/core >=1 <2`
 * as parsers (node_modules/dependency-cruiser/src/meta.cjs). This repo pins `typescript@7.0.2`
 * (out of range), so `@swc/core` (registry-pinned, exact) is installed as the dep-cruiser parser —
 * `depcruise --info` must show `.ts ✔`. The `deep-import-ts` fixture exists precisely to keep
 * that true: if TS parsing silently regresses, it stops firing and this selftest exits non-zero
 * (hollow-gate prevention, ADR-0010's spirit).
 */
// (tools/**), not client-side/browser code -- `noNodejsModules` exists for the latter (biome.jsonc
// enables the full "correctness" group at error, which sweeps this rule in repo-wide).
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { ICruiseOptions } from 'dependency-cruiser';
import { cruise } from 'dependency-cruiser';
import extractDepcruiseOptions from 'dependency-cruiser/config-utl/extract-depcruise-options';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');
const CONFIG_PATH = path.join(REPO_ROOT, '.dependency-cruiser.cjs');
const FIXTURES_ROOT = path.join(SCRIPT_DIR, '..', 'test', 'fixtures');

type FixtureCase =
  | { readonly dir: string; readonly expect: 'ok' }
  | { readonly dir: string; readonly expect: 'violation'; readonly rule: string };

const FIXTURES: readonly FixtureCase[] = [
  { dir: 'violations/deep-import', expect: 'violation', rule: 'no-cross-module-internals' },
  // TS-source twin of deep-import: guards that .ts files are PARSED (swc under TS7 — see header).
  { dir: 'violations/deep-import-ts', expect: 'violation', rule: 'no-cross-module-internals' },
  // The same rule, proven for a PRIMITIVE path: reaching past `@repo/styles`' barrel into
  // `src/primitives/button` must fail exactly like any other deep import.
  {
    dir: 'violations/deep-import-primitive',
    expect: 'violation',
    rule: 'no-cross-module-internals',
  },
  { dir: 'violations/kernel-imports-facade', expect: 'violation', rule: 'tier-direction' },
  { dir: 'violations/feature-imports-feature', expect: 'violation', rule: 'fe-slice-isolation' },
  // The other half of fe-slice-isolation — `shared/` importing a feature.
  { dir: 'violations/shared-imports-feature', expect: 'violation', rule: 'fe-slice-isolation' },
  { dir: 'violations/tier2-unsanctioned', expect: 'violation', rule: 'no-tier2-unsanctioned' },
  { dir: 'violations/circular', expect: 'violation', rule: 'no-circular' },
  {
    dir: 'violations/sdk-outside-runtime',
    expect: 'violation',
    rule: 'adapters-and-sdk-only-in-runtime',
  },
  {
    dir: 'violations/observability-sdk-outside-runtime',
    expect: 'violation',
    rule: 'observability-sdk-entry-only-in-runtime',
  },
  // An app declaring its own row schema under src/db/ instead of importing the shape from
  // @repo/entities through @repo/persistence.
  { dir: 'violations/no-app-row-schemas', expect: 'violation', rule: 'no-app-row-schemas' },
  { dir: 'ok/facade-imports-kernel', expect: 'ok' },
  { dir: 'ok/barrel-import', expect: 'ok' },
  { dir: 'ok/sdk-in-runtime', expect: 'ok' },
  { dir: 'ok/observability-sdk-in-runtime', expect: 'ok' },
  { dir: 'ok/routes-import-features', expect: 'ok' },
  // The migrate CLI's own db/ code, which needs no zod — the green twin of no-app-row-schemas.
  { dir: 'ok/no-app-row-schemas', expect: 'ok' },
];

interface FixtureOutcome {
  readonly dir: string;
  readonly pass: boolean;
  readonly detail: string;
}

async function runFixture(
  fixture: FixtureCase,
  baseOptions: ICruiseOptions,
): Promise<FixtureOutcome> {
  const baseDir = path.join(FIXTURES_ROOT, fixture.dir);
  const result = await cruise(['.'], { ...baseOptions, baseDir, validate: true });
  const output = result.output;
  if (typeof output === 'string') {
    // Only happens if `outputType` ends up set to a string-producing reporter; this script never
    // sets it, so an object is expected — narrow, don't assert.
    throw new Error(`fixture '${fixture.dir}': expected a structured cruise result, got a string`);
  }
  const violatedRules = new Set(output.summary.violations.map((violation) => violation.rule.name));
  const violatedRuleList = [...violatedRules].join(', ');

  if (fixture.expect === 'ok') {
    return violatedRules.size === 0
      ? { dir: fixture.dir, pass: true, detail: 'clean, as expected' }
      : {
          dir: fixture.dir,
          pass: false,
          detail: `expected no violations, got: [${violatedRuleList}]`,
        };
  }

  return violatedRules.has(fixture.rule)
    ? { dir: fixture.dir, pass: true, detail: `fired '${fixture.rule}', as expected` }
    : {
        dir: fixture.dir,
        pass: false,
        detail: `expected rule '${fixture.rule}' to fire, got: [${violatedRuleList}]`,
      };
}

async function main(): Promise<number> {
  const depcruiseOptions = await extractDepcruiseOptions(CONFIG_PATH);

  const outcomes: FixtureOutcome[] = [];
  for (const fixture of FIXTURES) {
    // Sequential on purpose — see header note on concurrent `cruise()` calls.
    outcomes.push(await runFixture(fixture, depcruiseOptions));
  }

  let failureCount = 0;
  for (const outcome of outcomes) {
    console.log(`${outcome.pass ? 'ok  ' : 'FAIL'} ${outcome.dir} — ${outcome.detail}`);
    if (!outcome.pass) {
      failureCount += 1;
    }
  }
  console.log(
    `run-fixture-tests: ${outcomes.length - failureCount}/${outcomes.length} fixtures passed.`,
  );

  return failureCount > 0 ? 1 : 0;
}

process.exit(await main());
