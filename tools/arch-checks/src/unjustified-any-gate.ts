/**
 * ADR-0003 "no `any`/`@ts-expect-error` without a written justification comment naming the constraint"
 * gate, made mechanical. Every `as any` / `@ts-expect-error` / `@ts-expect-error` in product source must
 * carry a justification comment on its own line or the line immediately above it — this repo's
 * convention is a comment containing the word "constraint" (matching the ADR's own phrasing
 * rather than inventing a new marker syntax).
 *
 * Zero npm dependencies, the `no-core-logging.ts` scanner pattern: plain line-matching over
 * `packages/*\/src/**` and `apps/*\/src/**`. Generated files (suffix `.gen.ts`) are exempt: a
 * justification comment there would be immediately overwritten by the generator and would
 * document nothing.
 *
 * Two justification-comment shapes are accepted, both already in use in this repo: a comment
 * containing the word "constraint" (ADR-0003's own phrasing), or a
 * `biome-ignore lint/suspicious/noExplicitAny: <reason>` comment with a non-empty reason (the
 * shape Biome's own suppression convention requires).
 *
 * BOTH MARKERS ARE `//` LINE COMMENTS ONLY — a `/* … constraint … *\/` block comment does NOT
 * satisfy this gate, ruled deliberate rather than a bug. The reason is that the gate's whole value
 * is being mechanical: accepting block comments means deciding how far above the directive a
 * multi-line comment may start and which of its lines count, and every answer to that is a
 * judgement call a grep cannot make consistently. The cost is one keystroke — write the
 * justification as `//` lines. What the gate must NOT accept is a bare marker with no reason, and
 * it does not: a lone `// x` above the line leaves it red.
 *
 * CLI: `bun tools/arch-checks/src/unjustified-any-gate.ts [repoRoot]`. With no arguments it checks
 * the real repo — this is what the `root:unjustified-any-gate` moon task / CI job runs. The
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

// `as any` (word-boundaried so it does not match `assay`/`asany`-style identifiers) in CODE.
const AS_ANY_RE = /\bas\s+any\b/;
// A real suppression DIRECTIVE — the comment's own content starts with it, e.g.
// `// @ts-expect-error — reason` — as opposed to a doc comment merely mentioning the directive in
// prose, which is documentation, not a directive, and must not be flagged.
const DIRECTIVE_RE = /^\s*(?:\/\/|\*)\s*(@ts-ignore|@ts-expect-error)\b(.*)$/;
// A line that is ENTIRELY a comment (block-comment body or `//` line) — used to skip prose that
// merely mentions a directive/`as any` rather than using one.
const COMMENT_ONLY_LINE_RE = /^\s*(\/\/|\*|\/\*\*?)/;
// This repo's justification markers on a non-directive line: a comment containing "constraint"
// (ADR-0003's own phrasing — "a written reason naming the constraint"), or a
// `biome-ignore lint/suspicious/noExplicitAny: <reason>` comment with a non-empty reason.
const JUSTIFICATION_RE =
  /\/\/.*constraint|\/\/\s*biome-ignore\s+lint\/suspicious\/noExplicitAny:\s*\S/i;

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
    if (
      entry.isFile() &&
      (entryPath.endsWith('.ts') || entryPath.endsWith('.tsx')) &&
      !entryPath.endsWith('.d.ts') &&
      !entryPath.endsWith('.gen.ts')
    ) {
      files.push(entryPath);
    }
  }
  return files;
}

function listModuleSrcFiles(repoRoot: string, workspaceFolder: string): string[] {
  const folderPath = path.join(repoRoot, workspaceFolder);
  if (!existsSync(folderPath)) {
    return [];
  }
  const files: string[] = [];
  for (const entry of readdirSync(folderPath, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    files.push(...listTsFiles(path.join(folderPath, entry.name, 'src')));
    files.push(...listTsFiles(path.join(folderPath, entry.name, 'test')));
    files.push(...listTsFiles(path.join(folderPath, entry.name, 'test-integration')));
  }
  return files;
}

function scanFile(repoRoot: string, absolutePath: string): Violation[] {
  const relativePath = toPosix(path.relative(repoRoot, absolutePath));
  const lines = readFileSync(absolutePath, 'utf8').split('\n');
  const violations: Violation[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    const directiveMatch = DIRECTIVE_RE.exec(line);
    if (directiveMatch) {
      // A directive with its own inline reasoning ("// @ts-expect-error — reason", possibly
      // continued on the next comment line) is self-justifying; a bare directive with no text
      // after it, on this line or continued below, is not.
      const inlineReason = (directiveMatch[2] ?? '').trim();
      const nextLine = i + 1 < lines.length ? (lines[i + 1] ?? '') : '';
      const continuedReason =
        inlineReason.length === 0 && COMMENT_ONLY_LINE_RE.test(nextLine) && nextLine.trim() !== '';
      if (inlineReason.length === 0 && !continuedReason) {
        violations.push({
          file: relativePath,
          line: i + 1,
          message: `unjustified '${directiveMatch[1]}' — ADR-0003 requires a comment naming the constraint: ${line.trim()}`,
        });
      }
      continue;
    }

    // A doc-comment/prose line merely mentioning a directive or "as any" (e.g. explaining the
    // mechanism) is not a use of either — only code lines are scanned for `as any`.
    if (COMMENT_ONLY_LINE_RE.test(line)) {
      continue;
    }

    if (!AS_ANY_RE.test(line)) {
      continue;
    }
    const previousLine = i > 0 ? (lines[i - 1] ?? '') : '';
    const justified = JUSTIFICATION_RE.test(line) || JUSTIFICATION_RE.test(previousLine);
    if (!justified) {
      violations.push({
        file: relativePath,
        line: i + 1,
        message: `unjustified 'as any' — ADR-0003 requires a comment naming the constraint, on the same line or the line above: ${line.trim()}`,
      });
    }
  }
  return violations;
}

/**
 * Checks `repoRoot` for unjustified `as any` / `@ts-expect-error` / `@ts-expect-error` (ADR-0003).
 * Exported so the fixture self-test and the real-CLI entrypoint below share identical logic
 * against different directories.
 */
export function checkUnjustifiedAny(repoRoot: string): Violation[] {
  const violations: Violation[] = [];
  for (const workspaceFolder of PRODUCT_SOURCE_ROOTS) {
    for (const file of listModuleSrcFiles(repoRoot, workspaceFolder)) {
      violations.push(...scanFile(repoRoot, file));
    }
  }
  return violations;
}

function main(): number {
  const [, , repoRootArg] = process.argv;
  const repoRoot = repoRootArg !== undefined ? path.resolve(repoRootArg) : REPO_ROOT;
  const violations = checkUnjustifiedAny(repoRoot);
  if (violations.length === 0) {
    console.log('unjustified-any-gate: no violations found.');
    return 0;
  }
  console.error('unjustified-any-gate: violations found:');
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} — ${violation.message}`);
  }
  return 1;
}

// Guarded so the fixture self-test can `import` this module's exports without also triggering a
// real-repo run as a side effect.
if (import.meta.main) {
  process.exit(main());
}
