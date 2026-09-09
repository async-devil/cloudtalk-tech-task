/**
 * ADR-0001 point 3's "extraction-per-changed-module in PR CI": every module this PR actually
 * touched must still pass the real `extract-module` proof — not just the fixed self-test target
 * `extract-module-selftest` already runs unconditionally. The full matrix over every liftable
 * package (`extract-module --all`) is a scheduled run's job, outside per-PR CI — this script is
 * strictly the affected-scoped per-PR half.
 *
 * `bun tools/extract-module/src/extract-changed.ts [baseRef]`. Resolves the changed-file set via
 * `git diff --name-only <baseRef>...HEAD` (baseRef defaults to `origin/${GITHUB_BASE_REF}` when
 * running under a `pull_request` GitHub Actions event, else `origin/main` — the same "changed
 * against main" resolution `moon ci`'s own affected-target scoping already relies on, which is
 * why the CI workflow's checkout step needs `fetch-depth: 0`), maps every changed path under
 * `packages/*\/` or `tools/*\/` to its folder name, and — for every changed folder that is a real,
 * `liftable`-tagged workspace package (apps are never extraction targets, ADR-0001's named
 * exception; a changed folder that resolves to no package, e.g. deleted this PR, is skipped) —
 * runs the real `extractModule` proof against it. Exits non-zero if any extraction fails, or if
 * `git diff` itself cannot resolve `baseRef` (a silently-empty diff would read as "nothing
 * changed", exactly the false-green shape the testing strategy exists to prevent, ADR-0010).
 *
 * On a PR that touches no liftable package (docs-only, app-only, tooling-only) this runs zero
 * extractions and exits 0 — there is nothing to prove.
 *
 * ONE EXCEPTION: some changed paths are an input to every extraction rather than to one module,
 * and for those the affected set is "all of them" — see {@link GLOBAL_EXTRACTION_INPUT_PREFIXES}
 * for the measurement that establishes it.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { type ExtractionResult, extractModule } from './extract.js';
import { discoverWorkspace, liftablePackages } from './workspace.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');

function resolveBaseRef(explicitBaseRef: string | undefined): string {
  if (explicitBaseRef !== undefined) {
    return explicitBaseRef;
  }
  const githubBaseRef = process.env.GITHUB_BASE_REF;
  if (githubBaseRef !== undefined && githubBaseRef !== '') {
    return `origin/${githubBaseRef}`;
  }
  return 'origin/main';
}

/**
 * Files that are an input to EVERY extraction, and whose change therefore cannot be scoped to any
 * one module: the whole liftable matrix has to run.
 *
 * This closes the same gap a scope-only gate always has — a gate scoped to the things it protects
 * (the modules) rather than to the things that can break them. `extract.ts` copies
 * `tsconfig.base.json` verbatim into every temp workspace and pins `typescript` out of the ROOT
 * `package.json` into every extracted package; `tools/extract-module` IS the prover. A PR touching
 * only those would otherwise run ZERO extractions. Measured, not reasoned: a change to
 * `tsconfig.base.json`'s strictness flags can leave one module green while another fails its
 * extracted `tsc` build on a third-party package's shipped `.d.ts` files — the cheapest module to
 * extract is not necessarily a representative one, so a fixed smoke target is not a substitute
 * here.
 *
 * The cost of this is real and accepted: a TypeScript bump, a `tsconfig.base.json` edit, or a
 * change to the extraction tool itself now pays the full liftable-package matrix on that PR. Those
 * are exactly the PRs that can break all of them at once, and the alternative is a gate that sits
 * out precisely when it is needed.
 */
export const GLOBAL_EXTRACTION_INPUT_PREFIXES: readonly string[] = [
  'tsconfig.base.json',
  'package.json',
  'tools/extract-module/',
];

/** Exported for `src/selftest.ts`. True when a changed path is one of the repo-global extraction
 * inputs above — note `package.json` matches the ROOT manifest only, never
 * `packages/<x>/package.json`, which is that module's own business. */
export function isGlobalExtractionInput(changedPath: string): boolean {
  return GLOBAL_EXTRACTION_INPUT_PREFIXES.some((prefix) =>
    prefix.endsWith('/') ? changedPath.startsWith(prefix) : changedPath === prefix,
  );
}

/** Exported so `src/selftest.ts` can exercise the path -> folder-name mapping without shelling out
 * to git. `packages/jobs/src/stage.ts` -> `jobs`; `tools/extract-module/src/index.ts` ->
 * `extract-module`; anything else (apps/**, docs/**, root files) -> undefined. */
export function changedFolderName(changedPath: string): string | undefined {
  const match = /^(?:packages|tools)\/([^/]+)\//.exec(changedPath);
  return match?.[1];
}

/** Exported for the same reason: the set of distinct candidate folder names a changed-file list
 * implies, deduplicated and order-preserving. */
export function changedFolderNames(changedPaths: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const ordered: string[] = [];
  for (const changedPath of changedPaths) {
    const folderName = changedFolderName(changedPath);
    if (folderName !== undefined && !seen.has(folderName)) {
      seen.add(folderName);
      ordered.push(folderName);
    }
  }
  return ordered;
}

function gitDiffChangedFiles(repoRoot: string, baseRef: string): readonly string[] {
  const output = execFileSync('git', ['diff', '--name-only', `${baseRef}...HEAD`], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return output.split('\n').filter((line) => line.trim() !== '');
}

function printResult(result: ExtractionResult): void {
  if (result.success) {
    // The honesty rule: an extraction that ran no tests must never print the same as one that
    // did — see `extract.ts`'s `ExtractionResult.ranTests`.
    const suffix = result.ranTests ? '' : ' (build-only)';
    console.log(`extract-changed: PASS "${result.folderName}"${suffix}`);
    return;
  }
  console.error(
    `extract-changed: FAIL "${result.folderName}": ${result.failureDetail ?? 'unknown failure'}`,
  );
  if (result.tempDir !== undefined) {
    console.error(`  left for inspection: ${result.tempDir}`);
  }
}

function main(): number {
  const [, , baseRefArg] = process.argv;
  const baseRef = resolveBaseRef(baseRefArg);

  let changedFiles: readonly string[];
  try {
    changedFiles = gitDiffChangedFiles(REPO_ROOT, baseRef);
  } catch (error) {
    console.error(
      `extract-changed: could not resolve changed files against "${baseRef}" — ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return 1;
  }

  const workspace = discoverWorkspace(REPO_ROOT);

  const globalInputs = changedFiles.filter(isGlobalExtractionInput);
  if (globalInputs.length > 0) {
    console.log(
      `extract-changed: repo-global extraction input(s) changed (${globalInputs.join(', ')}) — ` +
        'these are an input to EVERY extraction, so the full liftable matrix runs.',
    );
  }

  const candidateFolders = changedFolderNames(changedFiles);
  const targets =
    globalInputs.length > 0
      ? liftablePackages(workspace)
      : candidateFolders
          .map((folderName) => workspace.get(folderName))
          .filter((pkg): pkg is NonNullable<typeof pkg> => pkg?.tags.has('liftable') === true);

  if (targets.length === 0) {
    console.log(
      `extract-changed: no liftable module changed against ${baseRef} — nothing to extract.`,
    );
    return 0;
  }

  console.log(
    `extract-changed: ${targets.length} liftable module(s) to extract for ${baseRef}: ${targets
      .map((t) => t.folderName)
      .join(', ')}`,
  );
  let allPassed = true;
  for (const target of targets) {
    const result = extractModule(target.folderName, { repoRoot: REPO_ROOT });
    printResult(result);
    allPassed = allPassed && result.success;
  }
  return allPassed ? 0 : 1;
}

if (import.meta.main) {
  process.exit(main());
}
