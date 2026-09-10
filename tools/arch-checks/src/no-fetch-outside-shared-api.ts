/**
 * The no-fetch-outside-shared-api gate (ADR-0012's "network access goes through `shared/api`
 * only", made structural): `apps/app/src/shared/api/` is the ONE sanctioned place the SPA may
 * call the browser's `fetch`. A bare `fetch(` — or the equivalent `globalThis.fetch(` — anywhere
 * else under `apps/app/src/**` is a violation, because that is exactly how an untyped, unretried,
 * unauthenticated call gets into a component (`apps/app/src/shared/api/index.ts`'s own header
 * comment names this gate and relies on it existing).
 *
 * SPA-SPECIFIC, DELIBERATELY NOT REPO-WIDE. `packages/*` and every app other than `apps/app` never
 * call browser `fetch` this way — `packages/*` is server-side/shared code with no `fetch` of its
 * own, and `apps/api` is the server, which talks outbound through its own adapters, not this
 * pattern — so this scanner walks only `apps/app/src/**`, not `PRODUCT_SOURCE_ROOTS` as a whole.
 *
 * Zero npm dependencies, the `no-core-logging.ts` scanner pattern: plain line-matching over
 * `apps/app/src/**`, not a full TS/AST parse.
 *
 * MATCHING RULE. `VIOLATION_RE` below fires on:
 *   - a BARE call — `fetch(` not immediately preceded by a `.` or a word character, so it does not
 *     false-positive on `prefetch(` (preceded by a letter) or on `apiClient.fetch(` (a property
 *     named `.fetch`, which is not the global);
 *   - `globalThis.fetch(` specifically — the one sanctioned call shape inside `shared/api/`,
 *     matched explicitly since it IS preceded by a `.` and would otherwise be excluded by the bare
 *     rule above.
 *
 * COMMENT-ONLY LINES ARE SKIPPED, the same `COMMENT_ONLY_LINE_RE` idiom `unjustified-any-gate.ts`
 * uses and for the identical reason: `apps/app/src/shared/session/auth-client.ts`'s own header
 * comment explains this gate in prose and contains the literal substring `` `fetch(` `` inside a
 * doc comment — documentation mentioning the pattern is not a use of it, and without this skip the
 * gate would flag its own explanatory comment as a violation.
 *
 * ONLY ONE EXCLUSION: `apps/app/src/shared/api/**` (the sanctioned call site). Unlike
 * `no-core-logging`, there is no second boundary subtree and no per-file allowlist — the rule has
 * exactly one carve-out, so the whole file is excluded rather than scanned line-by-line for it.
 *
 * CLI: `bun tools/arch-checks/src/no-fetch-outside-shared-api.ts [repoRoot]`. With no arguments it
 * checks the real repo — this is what the `root:no-fetch-outside-shared-api` moon task / CI job
 * runs. The optional argument exists so the fixture self-test can point the identical checker at a
 * fixture directory instead.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** The one app this rule governs (ADR-0012 names `shared/api` as this app's kernel, not the
 * workspace's). */
const APP_SRC_ROOT = 'apps/app/src';

/** The one sanctioned call site, POSIX-separated and relative to repo root. A whole-file
 * exclusion, not a line-level allowlist — `shared/api/index.ts`'s `fetch:` option IS the pattern
 * this gate exists to confine. */
const ALLOWED_PREFIX = 'apps/app/src/shared/api/';

// A bare `fetch(` (not `prefetch(`, not a `.fetch(` property access) OR `globalThis.fetch(`
// specifically. See the header comment above for why each half is shaped the way it is.
const VIOLATION_RE = /(?<![.\w])fetch\(|globalThis\.fetch\(/;

// A line that is ENTIRELY a comment (block-comment body or `//` line) — mirrors
// `unjustified-any-gate.ts`'s `COMMENT_ONLY_LINE_RE` so prose that merely mentions `fetch(` (e.g.
// explaining this very gate) is not treated as a call to it.
const COMMENT_ONLY_LINE_RE = /^\s*(\/\/|\*|\/\*\*?)/;

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

function listTsFiles(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTsFiles(entryPath));
      continue;
    }
    // `.tsx` as well as `.ts`: this is a React app, and a component file is exactly where a
    // stray `fetch(` would land. `.d.ts` is excluded — a type-only file calls nothing.
    if (
      entry.isFile() &&
      (entryPath.endsWith('.ts') || entryPath.endsWith('.tsx')) &&
      !entryPath.endsWith('.d.ts')
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

function isAllowed(relativePath: string): boolean {
  return relativePath.startsWith(ALLOWED_PREFIX);
}

function scanFile(repoRoot: string, absolutePath: string): Violation[] {
  const relativePath = toPosix(path.relative(repoRoot, absolutePath));
  if (isAllowed(relativePath)) {
    return [];
  }
  const lines = readFileSync(absolutePath, 'utf8').split('\n');
  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (COMMENT_ONLY_LINE_RE.test(line)) {
      continue;
    }
    if (VIOLATION_RE.test(line)) {
      violations.push({
        file: relativePath,
        line: i + 1,
        message: `fetch outside shared/api — ${line.trim()}`,
      });
    }
  }
  return violations;
}

/**
 * Checks `repoRoot` for no-fetch-outside-shared-api violations. Exported so the fixture self-test
 * and the real-CLI entrypoint below share identical logic against different directories.
 */
export function checkNoFetchOutsideSharedApi(repoRoot: string): Violation[] {
  const violations: Violation[] = [];
  const srcDir = path.join(repoRoot, APP_SRC_ROOT);
  for (const file of listTsFiles(srcDir)) {
    violations.push(...scanFile(repoRoot, file));
  }
  return violations;
}

function reportViolations(violations: readonly Violation[]): void {
  console.error('no-fetch-outside-shared-api: violations found:');
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} — ${violation.message}`);
  }
}

function main(): number {
  const [, , repoRootArg] = process.argv;
  const repoRoot = repoRootArg !== undefined ? path.resolve(repoRootArg) : REPO_ROOT;

  const violations = checkNoFetchOutsideSharedApi(repoRoot);
  if (violations.length === 0) {
    console.log('no-fetch-outside-shared-api: no violations found.');
    return 0;
  }

  reportViolations(violations);
  return 1;
}

// Guarded so the fixture self-test can `import` `checkNoFetchOutsideSharedApi` without also
// triggering a real-repo CLI run as a side effect (mirrors no-core-logging.ts).
if (import.meta.main) {
  process.exit(main());
}
