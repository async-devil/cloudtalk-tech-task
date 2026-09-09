/**
 * The two questions "which directories does this repo's tooling walk?" have two different
 * answers, and this file is where both are written down once. Before it, each answer was a
 * literal array copied into every scanner that needed it — a shape where a new workspace glob can
 * become a real workspace member that dependency-cruiser never receives, so every ADR-0001 rule
 * would evaluate to nothing there while `depcruise-completeness.ts` reports it fully covered — it
 * asks whether a package is REGISTERED, not whether it is SCANNED.
 */
// (tools/**), not client-side/browser code -- `noNodejsModules` exists for the latter (biome.jsonc
// enables the full "correctness" group at error, which sweeps this rule in repo-wide).

import { readFileSync } from 'node:fs';
import path from 'node:path';

/**
 * The roots that hold PRODUCT source — the answer for every scanner enforcing a rule about code
 * this repo ships (`no-core-logging`, `unjustified-any-gate`, `no-cjs-exports-map`,
 * `telemetry-map`).
 *
 * **`tools/*` is deliberately absent, and that is a ruling rather than an omission.** It holds
 * CLI/verification code, not a shipped module: the files in `tools/arch-checks/src/` are gate
 * scripts of exactly the same kind that print their findings with `console.error`, for exactly
 * the same reason. A `tools/*` member that ever ships product code would need its own decision
 * here, not a silent inheritance of one taken for `packages/*`.
 *
 * This is NOT the list dependency-cruiser is handed. Boundary rules apply to every workspace
 * member including the verification harnesses, which is what {@link workspaceFolders} is for.
 */
export const PRODUCT_SOURCE_ROOTS: readonly string[] = ['packages', 'apps'];

interface RootPackageJson {
  readonly workspaces?: readonly string[];
}

/**
 * The top-level folder of every root `workspaces` glob, de-duplicated and order-preserving —
 * the answer for anything that must see EVERY workspace member (dependency-cruiser's scan roots,
 * `depcruise-completeness.ts`'s enumeration).
 *
 * Derived rather than written, and shared rather than copied, so the "is it scanned?" and "is it
 * registered?" halves are structurally incapable of disagreeing: a new glob is covered by both
 * the moment it is added, with no second list to remember and no second parser to keep in step.
 *
 * Only one-level `<folder>/*` globs are supported, and an unsupported shape THROWS rather than
 * being skipped — skipping would hand back a silently short list, which is the exact failure
 * this derivation exists to make impossible.
 */
export function workspaceFolders(repoRoot: string): readonly string[] {
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const parsed = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as RootPackageJson;
  if (!parsed.workspaces || parsed.workspaces.length === 0) {
    throw new Error(`${packageJsonPath} has no "workspaces" globs — nothing to enumerate.`);
  }
  const folders: string[] = [];
  for (const glob of parsed.workspaces) {
    if (!glob.endsWith('/*')) {
      throw new Error(
        `unsupported workspace glob "${glob}" — only one-level "<folder>/*" globs are supported.`,
      );
    }
    const folder = glob.slice(0, -2);
    // Two globs sharing a folder is not reachable from today's package.json, but the de-dup is
    // what makes this function's contract ("the folders", not "one per glob") true for any input
    // — and the arch-checks self-test exercises it, so it is a tested branch rather than a
    // defensive one nothing would notice the loss of.
    if (!folders.includes(folder)) {
      folders.push(folder);
    }
  }
  return folders;
}
