/**
 * ADR-0002 no-CJS gate: "No CJS artifacts anywhere" for shipped modules, made mechanical. Two
 * independent checks:
 *
 *  (a) every `packages/*\/package.json` / `apps/*\/package.json` `exports` map carries no
 *      `require` condition and no value ending `.cjs` — a dual ESM+CJS `exports` map is exactly
 *      the exports-map bug class ADR-0002 rejects.
 *  (b) no `.cjs` file exists anywhere in the repo (excluding `node_modules`) outside the named
 *      exemption list below — tool-consumed CommonJS config that their consumers `require()`
 *      synchronously, not a build artifact or shipped module.
 *
 * Zero npm dependencies, the `no-core-logging.ts` scanner pattern: plain JSON/text reads, no
 * YAML/AST parsing.
 *
 * CLI: `bun tools/arch-checks/src/no-cjs-exports-map.ts [repoRoot]`. With no arguments it checks
 * the real repo — this is what the `root:no-cjs-exports-map` moon task / CI job runs. The
 * optional argument lets the fixture self-test point the identical checker at a fixture directory
 * instead.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PRODUCT_SOURCE_ROOTS } from './workspace-roots.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

// The named exemption list (ADR-0002): tool-consumed config files their consumers require() as
// CommonJS, not build output or a runtime module. Repo-relative, POSIX-separated.
export const CJS_EXEMPTIONS: readonly string[] = [
  '.dependency-cruiser.cjs',
  'tools/arch-checks/src/module-registry.cjs',
  'tools/arch-checks/src/data-lifecycle-registry.cjs',
];

export interface Violation {
  readonly file: string;
  readonly message: string;
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function listWorkspacePackageJsonFiles(repoRoot: string): string[] {
  const files: string[] = [];
  for (const workspaceFolder of PRODUCT_SOURCE_ROOTS) {
    const folderPath = path.join(repoRoot, workspaceFolder);
    if (!existsSync(folderPath)) {
      continue;
    }
    for (const entry of readdirSync(folderPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageJsonPath = path.join(folderPath, entry.name, 'package.json');
      if (existsSync(packageJsonPath)) {
        files.push(packageJsonPath);
      }
    }
  }
  return files;
}

/** True if this exports-map value (string or nested conditions object) contains a CJS trace. */
function valueHasCjsTrace(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.endsWith('.cjs');
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'require') {
        return true;
      }
      if (valueHasCjsTrace(nested)) {
        return true;
      }
    }
  }
  return false;
}

function checkPackageJson(repoRoot: string, packageJsonPath: string): Violation[] {
  const relativePath = toPosix(path.relative(repoRoot, packageJsonPath));
  const raw = readFileSync(packageJsonPath, 'utf8');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return [{ file: relativePath, message: 'package.json is not valid JSON' }];
  }
  const exportsMap = parsed.exports;
  if (exportsMap === undefined) {
    return [];
  }
  if (valueHasCjsTrace(exportsMap)) {
    return [
      {
        file: relativePath,
        message:
          '"exports" carries a `require` condition or a `.cjs` target — ADR-0002 "No CJS artifacts anywhere" (dual ESM+CJS exports maps are the rejected alternative)',
      },
    ];
  }
  return [];
}

function listCjsFiles(dir: string, repoRoot: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (
      entry.name === 'node_modules' ||
      entry.name.startsWith('.git') ||
      // A developer/agent `git worktree` checked out under the repo tree (e.g. `.claude/worktrees/*`)
      // is a separate working copy, not this repo's own source — scanning it would double-count (or
      // false-positive on) files this checker already visits at their real path.
      entryPath === path.join(repoRoot, '.claude', 'worktrees') ||
      // Deliberate-violation arch-checks fixtures — this checker's scan root is the whole repo,
      // so it has to say so explicitly rather than simply never walking into the fixture tree.
      entryPath === path.join(repoRoot, 'tools', 'arch-checks', 'test', 'fixtures')
    ) {
      continue;
    }
    if (entry.isDirectory()) {
      files.push(...listCjsFiles(entryPath, repoRoot));
      continue;
    }
    if (entry.isFile() && entryPath.endsWith('.cjs')) {
      files.push(entryPath);
    }
  }
  return files;
}

function checkCjsFiles(repoRoot: string): Violation[] {
  const violations: Violation[] = [];
  for (const absolutePath of listCjsFiles(repoRoot, repoRoot)) {
    const relativePath = toPosix(path.relative(repoRoot, absolutePath));
    if (CJS_EXEMPTIONS.includes(relativePath)) {
      continue;
    }
    violations.push({
      file: relativePath,
      message: '.cjs file outside the ADR-0002 exemption list — no CJS artifacts anywhere',
    });
  }
  return violations;
}

/**
 * Checks `repoRoot` for ADR-0002 no-CJS violations. Exported so the fixture self-test and the
 * real-CLI entrypoint below share identical logic against different directories.
 */
export function checkNoCjsExportsMap(repoRoot: string): Violation[] {
  const violations: Violation[] = [];
  for (const packageJsonPath of listWorkspacePackageJsonFiles(repoRoot)) {
    violations.push(...checkPackageJson(repoRoot, packageJsonPath));
  }
  violations.push(...checkCjsFiles(repoRoot));
  return violations;
}

function main(): number {
  const [, , repoRootArg] = process.argv;
  const repoRoot = repoRootArg !== undefined ? path.resolve(repoRootArg) : REPO_ROOT;
  const violations = checkNoCjsExportsMap(repoRoot);
  if (violations.length === 0) {
    console.log('no-cjs-exports-map: no violations found.');
    return 0;
  }
  console.error('no-cjs-exports-map: violations found:');
  for (const violation of violations) {
    console.error(`  ${violation.file} — ${violation.message}`);
  }
  return 1;
}

// Guarded so the fixture self-test can `import` this module's exports without also triggering a
// real-repo run as a side effect.
if (import.meta.main) {
  process.exit(main());
}
