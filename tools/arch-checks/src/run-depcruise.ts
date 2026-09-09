/**
 * Wraps `depcruise` for the root `depcruise` moon task.
 *
 * dependency-cruiser errors when handed a directory argument that does not exist yet
 * ("ERROR: Can't open 'apps' for reading. Does it exist?", verified empirically against
 * 18.1.0) — so `depcruise --config .dependency-cruiser.cjs apps packages tools` cannot run
 * as-written on a tree where `apps` and `packages` don't exist yet. This task must exit 0 on
 * exactly that tree, and dependency-cruiser's own behavior cannot change, so this script filters
 * the candidate roots down to the ones actually present on disk before invoking it.
 *
 * A dedicated bun script (rather than shell glue in moon.yml) was chosen over inline
 * `$(...)`-substitution in a moon `script:` task: it is portable across whichever shell moon
 * picks per-OS, and it is independently testable/readable like the rest of this package's tools.
 *
 * THE ROOT LIST IS DERIVED, NOT WRITTEN. A literal `['apps', 'packages', 'tools']` array would
 * silently stop covering a workspace root the moment a new top-level `workspaces` glob is added:
 * the new folder would be a real workspace member, registered in `module-registry.cjs`, covered
 * by name-scoped rules, and never handed to dependency-cruiser at all. Every ADR-0001 rule would
 * then silently evaluate to nothing there — an import that violates a boundary rule would cruise
 * clean indefinitely. `depcruise-completeness.ts` could not catch it either: it asks whether a
 * package is REGISTERED, which would still be true, not whether it is SCANNED.
 *
 * Deriving from the same `workspaces` globs `depcruise-completeness.ts` enumerates makes the two
 * halves structurally incapable of disagreeing — a new workspace glob is scanned the moment it is
 * added, with no second list to remember. That is why this is a derivation rather than a fourth
 * entry in the array plus a check that the array is complete: a check can be forgotten, a
 * derivation cannot. `workspace-roots.ts` holds the one implementation both halves import: a
 * second hand-written copy of the same parse would be two lists that merely happen to agree.
 */
// (tools/**), not client-side/browser code -- `noNodejsModules` exists for the latter (biome.jsonc
// enables the full "correctness" group at error, which sweeps this rule in repo-wide).

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { cruise } from 'dependency-cruiser';
import { workspaceFolders } from './workspace-roots.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');

function main(): Promise<number> | number {
  const candidateRoots = workspaceFolders(REPO_ROOT);
  // Relative, not absolute: every rule regex in `.dependency-cruiser.cjs` is anchored to
  // repo-relative paths (`^apps/[^/]+/src/runtime/`), and dependency-cruiser reports paths
  // relative to its cwd. The moon root task runs from the workspace root, so these agree.
  const roots = candidateRoots.filter((root) => existsSync(path.join(REPO_ROOT, root)));

  if (roots.length === 0) {
    // Nothing on disk to cruise — a valid green state: the ruleset loads with zero projects.
    console.log(
      `depcruise: no workspace roots present yet (${candidateRoots.join('/')}) — nothing to cruise.`,
    );
    return 0;
  }

  return cruiseRoots(roots);
}

/**
 * The documented JS API, not the `depcruise` CLI — and that is a portability requirement rather
 * than a style choice. dependency-cruiser 18.1.0's bin refuses to start on Node below 22 ("Your
 * node version is not supported"), so on any host with an older Node the CLI form makes this gate
 * fail for a reason that has nothing to do with the code it checks. Called through the API from a
 * `bun` process, the same ruleset runs anywhere the repository's own pinned runtime does. It is
 * also the form `run-fixture-tests.ts` already uses, so the gate and its selftest now exercise
 * dependency-cruiser through one path instead of two.
 */
async function cruiseRoots(roots: readonly string[]): Promise<number> {
  // `require` rather than `import`: the ruleset is CommonJS by necessity (dependency-cruiser's own
  // loader reads it synchronously), and it must be read as the same module object the CLI would.
  const require = createRequire(path.join(REPO_ROOT, 'noop.cjs'));
  const config = require('./.dependency-cruiser.cjs') as {
    forbidden: unknown[];
    options: Record<string, unknown>;
  };

  const result = await cruise([...roots], {
    ...config.options,
    ruleSet: { forbidden: config.forbidden },
    // Every rule regex is anchored to repo-relative paths, and `baseDir` is what makes the
    // reported paths agree with them regardless of who invoked this script.
    baseDir: REPO_ROOT,
    outputType: 'err',
  } as Parameters<typeof cruise>[1]);

  const output = typeof result.output === 'string' ? result.output : JSON.stringify(result.output);
  if (result.exitCode !== 0) {
    console.error(output);
    return result.exitCode;
  }
  console.log(output.trim() || 'depcruise: no dependency violations found');
  return 0;
}

process.exit(await main());
