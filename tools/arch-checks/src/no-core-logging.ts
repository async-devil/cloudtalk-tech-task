/**
 * The no-core-logging gate (ADR-0009's "handled once at named boundaries", made structural):
 * handle-once means error-and-above logging may exist only at the ADR-0009 boundaries. `failSpan`
 * (packages/observability/src/fail-span.ts) is the one call site that emits the log for HTTP/job
 * (and bus) boundaries; nothing else in a module's core may call `logger.error(`/`logger.fatal(`/
 * `console.` directly.
 *
 * Zero npm dependencies, following the `gate-integrity.ts` pattern: plain line-matching over
 * `packages/*\/src/**` and `apps/*\/src/**`, not a full TS/AST parse. Info/debug logging is NOT
 * policed (boot reports, worker no-op guards are legitimate) — only the failure-logging surface
 * (`error`/`fatal`/`console.*`) is in scope.
 *
 * Two independent scopes:
 *  - `packages/*\/src/**`: any match is a violation UNLESS the file (or, for the bus boundary, a
 *    glob) is in {@link ALLOWED_PACKAGE_FILES}/{@link ALLOWED_PACKAGE_GLOBS}, or the file lives
 *    under {@link ALLOWED_PACKAGE_PREFIXES} (observability implements the logger and `failSpan`
 *    itself).
 *  - `apps/*\/src/**`: any match is a violation UNLESS the file lives under one of
 *    `src/http/**`, `src/routes/**`, `src/runtime/**` (the HTTP boundary + composition root), or
 *    is named individually in {@link ALLOWED_APP_FILES}.
 *
 * Tests (`test/**`) are out of scope entirely — this gate is about product source, not fixtures
 * or assertions on captured log lines.
 *
 * CLI: `bun tools/arch-checks/src/no-core-logging.ts [repoRoot]`. With no arguments it checks the
 * real repo — this is what the `root:no-core-logging` moon task / CI job runs. The optional
 * argument exists so the fixture self-test and the fixture runner can point the exact same
 * checker at a fixture directory instead.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PRODUCT_SOURCE_ROOTS } from './workspace-roots.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

// The failure-logging surface: `logger.error(`/`logger.fatal(` (the facade calls) and
// `console.*` (bypassing the facade entirely). Deliberately NOT `logger.warn`/`info`/`debug`.
const VIOLATION_RE = /logger\.error\(|logger\.fatal\(|console\.\w+\(/;

/**
 * Individual `packages/*` files allowed to call the failure-logging surface directly
 * (registry-style — one entry, one justifying comment).
 */
const ALLOWED_PACKAGE_FILES: readonly string[] = [
  // Job boundary: the worker wrapper wires `failSpan`'s `logger` option — kept on the allowlist
  // even though the literal `.error(`/`.fatal(` call itself lives inside `failSpan`
  // (observability/src/fail-span.ts, already covered by the prefix rule below); this entry stays
  // reserved for the job boundary rather than silently dropped.
  'packages/messaging/src/worker.ts',
  // The dead-letter boundary: writeDeadLetter IS the boundary — "the error's journey ends in this
  // row" (ADR-0009's handle-once) — and owns the one `logger.error` call that records it.
  'packages/jobs/src/dead-letter.ts',
];

/**
 * Glob-ish (single `*` wildcard only — zero-dep, no micromatch) entries for `packages/*` files
 * allowed to call the failure-logging surface directly.
 */
const ALLOWED_PACKAGE_GLOBS: readonly string[] = [
  // The bus boundary: reserved for a future bus-consumer entry point so that work doesn't also
  // require touching this gate.
  'packages/messaging/src/internal/bus*.ts',
];

/** Path PREFIXES (relative to repo root, POSIX-separated) whose entire subtree is allowed. */
const ALLOWED_PACKAGE_PREFIXES: readonly string[] = [
  // observability implements the logger AND `failSpan` itself — the whole package.
  'packages/observability/src/',
];

/** `apps/*` files are allowed only under these subtrees: the HTTP boundary + the composition
 * root (`src/runtime/**`, where `main.ts` and the raw job handlers live). */
const ALLOWED_APP_SUBTREES: readonly string[] = ['src/http/', 'src/routes/', 'src/runtime/'];

/**
 * Individual `apps/*` files allowed to call the failure-logging surface (registry-style, one
 * entry and one justifying comment — the `ALLOWED_PACKAGE_FILES` shape, applied to apps).
 */
const ALLOWED_APP_FILES: readonly string[] = [
  // The SPA's error-reporting boundary. A browser bundle cannot use `@repo/observability`
  // (server-side pino/OTel), so ADR-0009's "handled once, at a boundary" lands on this ONE
  // module — everything else in `apps/app` propagates to it, and the console write it guards is
  // development-only (removed from the production bundle). The subtree rule above cannot express
  // it: `src/shared/**` as a whole must keep the rule, and only this file inside it may break it.
  'apps/app/src/shared/observability/index.ts',
];

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

function globToRegExp(glob: string): RegExp {
  const pattern = glob
    .split('*')
    .map((literal) => literal.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
  return new RegExp(`^${pattern}$`);
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
    // `.tsx` as well as `.ts`: with a React app and JSX-carrying packages in the tree, scanning
    // only `.ts` would leave every component file outside this gate entirely, which is a
    // hollowed gate by omission rather than by intent.
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

/** Every `src/**\/*.{ts,tsx}` file (excluding `.d.ts`) under each `<workspaceFolder>/*\/src`
 * package. */
function listSourceFiles(repoRoot: string, workspaceFolder: string): string[] {
  const folderPath = path.join(repoRoot, workspaceFolder);
  if (!existsSync(folderPath)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(folderPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const srcDir = path.join(folderPath, entry.name, 'src');
    files.push(...listTsFiles(srcDir));
  }
  return files;
}

function isAllowedPackageFile(relativePath: string): boolean {
  if (ALLOWED_PACKAGE_FILES.includes(relativePath)) {
    return true;
  }
  if (ALLOWED_PACKAGE_GLOBS.some((glob) => globToRegExp(glob).test(relativePath))) {
    return true;
  }
  return ALLOWED_PACKAGE_PREFIXES.some((prefix) => relativePath.startsWith(prefix));
}

function isAllowedAppFile(relativePath: string): boolean {
  // relativePath is `apps/<name>/src/...` — the allowed subtrees are anchored right after `src/`.
  const srcIndex = relativePath.indexOf('/src/');
  if (srcIndex === -1) {
    return false;
  }
  if (ALLOWED_APP_FILES.includes(relativePath)) {
    return true;
  }
  const afterSrc = relativePath.slice(srcIndex + '/src/'.length);
  return ALLOWED_APP_SUBTREES.some((subtree) => afterSrc.startsWith(subtree.slice('src/'.length)));
}

function scanFile(
  repoRoot: string,
  absolutePath: string,
  isAllowed: (rel: string) => boolean,
): Violation[] {
  const relativePath = toPosix(path.relative(repoRoot, absolutePath));
  const lines = readFileSync(absolutePath, 'utf8').split('\n');
  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (VIOLATION_RE.test(line) && !isAllowed(relativePath)) {
      violations.push({
        file: relativePath,
        line: i + 1,
        message: `error/fatal logging (or console.*) outside a boundary — ${line.trim()}`,
      });
    }
  }
  return violations;
}

/**
 * Checks `repoRoot` for no-core-logging violations. Exported so the fixture self-test and the
 * real-CLI entrypoint below share identical logic against different directories.
 */
export function checkNoCoreLogging(repoRoot: string): Violation[] {
  const violations: Violation[] = [];

  // Roots from `PRODUCT_SOURCE_ROOTS` (one ruling, every scanner) rather than two literals here;
  // the allow-predicate still differs per root, which is why this is a loop with a lookup rather
  // than a flat file list.
  for (const workspaceFolder of PRODUCT_SOURCE_ROOTS) {
    const isAllowed = workspaceFolder === 'apps' ? isAllowedAppFile : isAllowedPackageFile;
    for (const file of listSourceFiles(repoRoot, workspaceFolder)) {
      violations.push(...scanFile(repoRoot, file, isAllowed));
    }
  }

  return violations;
}

function reportViolations(violations: readonly Violation[]): void {
  console.error('no-core-logging: violations found:');
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} — ${violation.message}`);
  }
}

function main(): number {
  const [, , repoRootArg] = process.argv;
  const repoRoot = repoRootArg !== undefined ? path.resolve(repoRootArg) : REPO_ROOT;

  const violations = checkNoCoreLogging(repoRoot);
  if (violations.length === 0) {
    console.log('no-core-logging: no violations found.');
    return 0;
  }

  reportViolations(violations);
  return 1;
}

// Guarded so the fixture self-test can `import` `checkNoCoreLogging` without also triggering a
// real-repo CLI run as a side effect (mirrors gate-integrity.ts).
if (import.meta.main) {
  process.exit(main());
}
