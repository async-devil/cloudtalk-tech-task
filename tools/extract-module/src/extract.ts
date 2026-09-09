/**
 * The extraction proof itself (ADR-0001 point 3): copies a module plus its transitive
 * `workspace:*` dependencies to a temp directory OUTSIDE the repo as flat sibling packages (never
 * a bun workspace — the point is to prove the module survives WITHOUT moon/bun's workspace
 * machinery, lifted into an unrelated project with only its declared dependencies), rewrites each
 * `workspace:*` edge to a `file:../<folder>` reference, then — strictly in dependency order, so a
 * package's `dist/` exists before anything `file:`-depending on it needs to resolve its types —
 * runs `bun install` + a real `tsc` build per package. Only the TARGET module's own unit test
 * suite runs (`vitest run`, its default `vitest.config.ts` — never `test-integration`, which needs
 * Testcontainers/Docker in whatever downstream environment this module gets dropped into and is
 * out of scope for what the extraction proof's plain "build && test" is proving). Its dependencies
 * are proven buildable here and get their own extraction pass, with their own tests, on their own
 * turn in the `--all` matrix.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverWorkspace, indexByPackageName, type WorkspacePackage } from './workspace.js';

export interface ExtractionResult {
  readonly folderName: string;
  readonly success: boolean;
  /**
   * True only when the target's own unit-test suite actually ran under `vitest`. False on any
   * failure, and also false for a successful extraction that ran no tests — either because the
   * module declares itself `"extraction": "build-only"` (see {@link extractionModeOf}) or because
   * its copied tree simply carried no `*.test.ts(x)` file. The caller uses this to report
   * `pass (build-only)` rather than a plain `pass`: a successful extraction that asserted nothing
   * must never read the same as one that did, or the honesty of the whole proof is negotiable.
   */
  readonly ranTests: boolean;
  /** Present only on failure — the temp dir is left on disk for inspection when this is set. */
  readonly failureDetail?: string;
  readonly tempDir?: string;
}

function gitTrackedFiles(repoRoot: string, relativeDir: string): ReadonlyArray<string> {
  const result = spawnSync('git', ['ls-files', '--', relativeDir], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(
      `extract-module: "git ls-files -- ${relativeDir}" failed: ${result.stderr || result.error}`,
    );
  }
  return result.stdout.split('\n').filter((line) => line.trim() !== '');
}

function copyTrackedFiles(repoRoot: string, pkg: WorkspacePackage, destDir: string): void {
  const trackedFiles = gitTrackedFiles(repoRoot, pkg.relativeDir);
  if (trackedFiles.length === 0) {
    throw new Error(
      `extract-module: "${pkg.relativeDir}" has no git-tracked files — nothing to extract`,
    );
  }
  for (const relativeFromRepoRoot of trackedFiles) {
    const relativeFromPackage = path.relative(pkg.relativeDir, relativeFromRepoRoot);
    const source = path.join(repoRoot, relativeFromRepoRoot);
    const destination = path.join(destDir, relativeFromPackage);
    mkdirSync(path.dirname(destination), { recursive: true });
    // Every git-tracked file a package needs for extraction is source text (.ts/.json/.md/...) —
    // a plain utf8 round-trip is exact and keeps the ambient node:fs surface to one signature shape.
    writeFileSync(destination, readFileSync(source, 'utf8'), 'utf8');
  }
}

/** Kahn's algorithm over the `workspace:*` edges reachable from `target` — dependencies first,
 * `target` itself last (it is the closure's root; every other node is a prerequisite of it, and
 * dependency-cruiser's `no-circular` rule already forbids a cycle reaching back to it). Exported
 * for `src/selftest.ts`'s in-memory fixture-graph proofs (tier-tooling's export-testable-internals
 * convention — see `workspace.ts`'s `parseMoonYamlTags` for the same). */
export function transitiveClosureInBuildOrder(
  target: WorkspacePackage,
  byPackageName: ReadonlyMap<string, WorkspacePackage>,
): ReadonlyArray<WorkspacePackage> {
  const closure = new Map<string, WorkspacePackage>();
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || closure.has(current.folderName)) {
      continue;
    }
    closure.set(current.folderName, current);
    for (const depName of current.workspaceDependencyNames) {
      const dep = byPackageName.get(depName);
      if (dep === undefined) {
        throw new Error(
          `extract-module: "${current.folderName}" depends on "${depName}" (workspace:*), ` +
            'but no workspace package declares that name',
        );
      }
      stack.push(dep);
    }
  }

  const inDegree = new Map<string, number>();
  for (const pkg of closure.values()) {
    inDegree.set(pkg.folderName, 0);
  }
  for (const pkg of closure.values()) {
    for (const depName of pkg.workspaceDependencyNames) {
      const depFolderName = byPackageName.get(depName)?.folderName;
      if (depFolderName !== undefined) {
        // depFolderName -> pkg.folderName is an edge in the "must build before" DAG.
        inDegree.set(pkg.folderName, (inDegree.get(pkg.folderName) ?? 0) + 1);
      }
    }
  }

  const ready = [...closure.values()].filter((pkg) => inDegree.get(pkg.folderName) === 0);
  const order: WorkspacePackage[] = [];
  while (ready.length > 0) {
    const next = ready.shift();
    if (next === undefined) {
      break;
    }
    order.push(next);
    for (const pkg of closure.values()) {
      if (!pkg.workspaceDependencyNames.has(next.name)) {
        continue;
      }
      const remaining = (inDegree.get(pkg.folderName) ?? 0) - 1;
      inDegree.set(pkg.folderName, remaining);
      if (remaining === 0) {
        ready.push(pkg);
      }
    }
  }

  if (order.length !== closure.size) {
    // Belt-and-braces: dep-cruiser's no-circular rule already forbids a cycle at the module-graph
    // level, so a correct workspace never reaches this branch.
    throw new Error(
      "extract-module: dependency closure has a cycle (dep-cruiser's no-circular should have caught this at the module-graph level)",
    );
  }
  return order;
}

/** Exported for `src/selftest.ts` (tier-tooling's export-testable-internals convention — see
 * `workspace.ts`'s `parseMoonYamlTags` for the same). Mutates the `package.json` already copied
 * into `destDir`. */
export function rewritePackageJsonForExtraction(
  destDir: string,
  byPackageName: ReadonlyMap<string, WorkspacePackage>,
  pinnedTypescriptVersion: string,
): void {
  const packageJsonPath = path.join(destDir, 'package.json');
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));

  for (const section of ['dependencies', 'devDependencies'] as const) {
    const deps = packageJson[section] as Record<string, string> | undefined;
    if (deps === undefined) {
      continue;
    }
    for (const [depName, versionSpecifier] of Object.entries(deps)) {
      if (versionSpecifier !== 'workspace:*') {
        continue;
      }
      const depFolderName = byPackageName.get(depName)?.folderName;
      if (depFolderName === undefined) {
        throw new Error(`extract-module: unresolved workspace dependency "${depName}"`);
      }
      deps[depName] = `file:../${depFolderName}`;
    }
  }

  // Every extracted package needs its own local `tsc` — the monorepo relies on the ROOT
  // package.json's devDependency for that, which does not travel with a standalone copy.
  // `vitest` already IS a per-package devDependency (every liftable package declares it), so no
  // injection needed there.
  packageJson.devDependencies = {
    ...(packageJson.devDependencies ?? {}),
    typescript: pinnedTypescriptVersion,
  };

  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`, 'utf8');
}

/** Exported for `src/selftest.ts` (tier-tooling's export-testable-internals convention — see
 * `workspace.ts`'s `parseMoonYamlTags` for the same). No-ops when `destDir` has no
 * `tsconfig.json` (a package with none, e.g. a future non-TS liftable package). */
export function rewriteTsconfigForExtraction(destDir: string): void {
  const tsconfigPath = path.join(destDir, 'tsconfig.json');
  if (!existsSync(tsconfigPath)) {
    return;
  }
  const raw = readFileSync(tsconfigPath, 'utf8');
  // The repo's tsconfigs are two levels deep (`packages/<name>/tsconfig.json` ->
  // `../../tsconfig.base.json`); an extracted package sits one level deep from the copied base
  // config (`<tmp>/<name>/tsconfig.json` -> `<tmp>/tsconfig.base.json`), so it is one `../`
  // shallower. Every tsconfig.json in this repo extends exactly this one file, so a literal
  // string replace is exact — not a general-purpose path rewrite.
  const rewritten = raw.replace('../../tsconfig.base.json', '../tsconfig.base.json');
  writeFileSync(tsconfigPath, rewritten, 'utf8');
}

export type ExtractionMode = 'build-and-test' | 'build-only';

/**
 * Reads a module's own extraction-mode declaration off its `package.json`: an `"extraction":
 * "build-only"` field, not a hardcoded name list. `styles` ships source rather than a build
 * (ADR-0001) and sets this field for exactly that reason — the exception is declared by the
 * module that has it, so a future source-shipping package opts in the same way instead of editing
 * this tool. Any other value, or the field's absence, means the ordinary `build-and-test` proof.
 * Exported for `src/selftest.ts`.
 */
export function extractionModeOf(packageJson: { readonly extraction?: unknown }): ExtractionMode {
  return packageJson.extraction === 'build-only' ? 'build-only' : 'build-and-test';
}

/**
 * Whether the extracted copy at `destDir` carries any unit-test file at all — i.e. whether
 * `vitest run` finding NOTHING would be truthful or would be a silently hollowed proof.
 *
 * Measured rather than assumed: vitest 4 already defaults `passWithNoTests` to false, so a
 * mis-globbed suite fails on its own. The real hole is the per-package opt-OUT — a package with
 * genuinely no unit suite sets `passWithNoTests: true` in its own `vitest.config.ts` deliberately,
 * and that setting is not scoped to "while there are no tests". The day such a package lands a
 * suite whose `include` glob does not match it, the extraction proof reports PASS having built the
 * package and asserted nothing, and the config that allows it will read as intentional.
 *
 * So: when tests DID travel into the copy, the CLI flag overrides whatever the config says and
 * vitest must actually find them. When the copy genuinely has none, a package that legitimately
 * opts out stays green as its config intends — reported as `pass (build-only)`, never plain
 * `pass`. Both branches are load-bearing; both are covered in the self-test.
 *
 * Every liftable package's `vitest.config.ts` globs its tests out of `test/` and matches
 * `.test.ts` / `.test.tsx`, and `test-integration/` is deliberately out of scope for extraction
 * (it needs Docker downstream) — hence the scan is `test/` alone.
 *
 * Exported for `src/selftest.ts`.
 */
export function copiedTreeHasUnitTests(destDir: string): boolean {
  const testDir = path.join(destDir, 'test');
  const walk = (dir: string): boolean => {
    let entries: ReturnType<typeof readdirSync>;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return false;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (walk(full)) {
          return true;
        }
        continue;
      }
      if (/\.test\.tsx?$/.test(entry.name)) {
        return true;
      }
    }
    return false;
  };
  return walk(testDir);
}

type StepResult = { readonly ok: true } | { readonly ok: false; readonly detail: string };

function runStep(
  label: string,
  command: string,
  args: ReadonlyArray<string>,
  cwd: string,
): StepResult {
  console.log(`  -> ${label}`);
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  // Status FIRST, `error` second. A process that ran and exited non-zero sets `status`, and on
  // some runtimes it also sets a bare `error` whose `message` is empty — reporting that first
  // produced `failed to spawn "bun": null` for an install that had actually run and exited 127
  // (a missing `node-gyp` for a transitive native dependency). The message named the wrong thing
  // entirely, which is worse than no message: it sends the reader looking for a PATH problem.
  if (typeof result.status === 'number') {
    if (result.status !== 0) {
      return {
        ok: false,
        detail: `${label}: exited ${String(result.status)} — see the output above`,
      };
    }
    return { ok: true };
  }
  if (result.error) {
    const reason = result.error.message ? result.error.message : 'no reason reported';
    return { ok: false, detail: `${label}: could not run "${command}": ${reason}` };
  }
  if (result.signal) {
    return { ok: false, detail: `${label}: killed by signal ${String(result.signal)}` };
  }
  return { ok: true };
}

function localBin(destDir: string, binName: string): string {
  return path.join(destDir, 'node_modules', '.bin', binName);
}

export interface ExtractOptions {
  readonly repoRoot: string;
  /** Keep the temp directory even on success (default: cleaned up on success, left on failure). */
  readonly keepTempDir?: boolean;
}

export function extractModule(targetFolderName: string, options: ExtractOptions): ExtractionResult {
  const { repoRoot } = options;
  const workspace = discoverWorkspace(repoRoot);
  const byPackageName = indexByPackageName(workspace);

  const target = workspace.get(targetFolderName);
  if (target === undefined) {
    return {
      folderName: targetFolderName,
      success: false,
      ranTests: false,
      failureDetail: `no workspace package found at "apps|packages|tools/${targetFolderName}"`,
    };
  }
  if (!target.tags.has('liftable')) {
    return {
      folderName: targetFolderName,
      success: false,
      ranTests: false,
      failureDetail:
        `"${targetFolderName}" is not tagged "liftable" in its moon.yml — ADR-0001's named ` +
        'exception (apps are deployables) is not an extraction target. Shipping source rather ' +
        'than a build (the `styles` shape) is not the same exception: that package IS tagged ' +
        'liftable and DOES pass a real extraction, declared build-only via its own package.json.',
    };
  }

  const rootPackageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const pinnedTypescriptVersion: string = rootPackageJson.devDependencies?.typescript;
  if (pinnedTypescriptVersion === undefined) {
    return {
      folderName: targetFolderName,
      success: false,
      ranTests: false,
      failureDetail:
        'root package.json has no devDependencies.typescript to pin into extracted packages',
    };
  }

  const targetPackageJson = JSON.parse(readFileSync(path.join(target.dir, 'package.json'), 'utf8'));
  const extractionMode = extractionModeOf(targetPackageJson);

  const buildOrder = transitiveClosureInBuildOrder(target, byPackageName);

  const tempDir = mkdtempSync(path.join(os.tmpdir(), 'extract-module-'));
  console.log(`extract-module: "${targetFolderName}" -> ${tempDir}`);
  console.log(`  build order: ${buildOrder.map((pkg) => pkg.folderName).join(' -> ')}`);

  try {
    writeFileSync(
      path.join(tempDir, 'tsconfig.base.json'),
      readFileSync(path.join(repoRoot, 'tsconfig.base.json'), 'utf8'),
      'utf8',
    );

    for (const pkg of buildOrder) {
      const destDir = path.join(tempDir, pkg.folderName);
      mkdirSync(destDir, { recursive: true });
      copyTrackedFiles(repoRoot, pkg, destDir);
      rewritePackageJsonForExtraction(destDir, byPackageName, pinnedTypescriptVersion);
      rewriteTsconfigForExtraction(destDir);
    }

    let ranTests = false;

    for (const pkg of buildOrder) {
      const destDir = path.join(tempDir, pkg.folderName);
      console.log(`  package: ${pkg.folderName}`);

      const install = runStep('bun install', 'bun', ['install'], destDir);
      if (!install.ok) {
        return {
          folderName: targetFolderName,
          success: false,
          ranTests: false,
          failureDetail: install.detail,
          tempDir,
        };
      }

      const build = runStep('tsc build', localBin(destDir, 'tsc'), [], destDir);
      if (!build.ok) {
        return {
          folderName: targetFolderName,
          success: false,
          ranTests: false,
          failureDetail: build.detail,
          tempDir,
        };
      }

      if (pkg.folderName === target.folderName) {
        if (extractionMode === 'build-only') {
          // Declared via package.json, not inferred from the shape of the copied tree — see
          // `extractionModeOf`. The module ships source rather than a build; its own test suite
          // (if it has one) still runs under moon in the real workspace, just not as part of this
          // OUT-OF-repo proof, whose "build && test" contract this field opts the module out of
          // for the test half only.
          console.log('  -> skipping vitest run: package.json declares "extraction": "build-only"');
        } else {
          // See `copiedTreeHasUnitTests`: when tests DID travel, `vitest`'s `passWithNoTests`
          // default must not be allowed to turn "found nothing to run" into a green extraction.
          const hasTests = copiedTreeHasUnitTests(destDir);
          const testArgs = hasTests ? ['run', '--passWithNoTests=false'] : ['run'];
          const test = runStep('vitest run', localBin(destDir, 'vitest'), testArgs, destDir);
          if (!test.ok) {
            return {
              folderName: targetFolderName,
              success: false,
              ranTests: false,
              failureDetail: test.detail,
              tempDir,
            };
          }
          ranTests = hasTests;
        }
      }
    }

    if (options.keepTempDir !== true) {
      rmSync(tempDir, { recursive: true, force: true });
    }
    return { folderName: targetFolderName, success: true, ranTests };
  } catch (error) {
    return {
      folderName: targetFolderName,
      success: false,
      ranTests: false,
      failureDetail: error instanceof Error ? error.message : String(error),
      tempDir,
    };
  }
}
