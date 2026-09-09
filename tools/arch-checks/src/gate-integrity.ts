/**
 * ADR-0010 anti-hollowing gate.
 *
 * Zero npm dependencies: GitHub Actions workflow YAML is scanned with plain line-matching, never
 * a full YAML parse -- the shape this repo's workflows use (top-level `jobs:` mapping, job ids at
 * exactly 2-space indent, steps below them) is narrow and fixed enough that a general YAML parser
 * would buy nothing but a new dependency.
 *
 * Two independent failure modes, both scanned across every `.github/workflows/*.yml`:
 *
 *  (a) a commented-out step line anywhere inside a `jobs:` mapping -- the exact decay mode ADR-0010
 *      names ("a CI step fails if workflow files contain commented-out steps within gate
 *      sections").
 *  (b) a job id required by `tools/arch-checks/required-gates.json` missing from its named
 *      workflow file -- the structural fix: removing a gate now means editing this manifest too,
 *      a loud and reviewable diff.
 *
 * CLI: `bun tools/arch-checks/src/gate-integrity.ts [workflowsDir] [requiredGatesPath]`. With no
 * arguments it checks the real repo (`.github/workflows/`, `tools/arch-checks/required-gates.json`)
 * -- this is what the `gate-integrity` moon task / CI job runs. The optional arguments exist so an
 * acceptance self-test and this package's fixture runner can point the exact same checker at a
 * fixture directory instead of the real repo.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');
const DEFAULT_REQUIRED_GATES_PATH = path.join(PACKAGE_ROOT, 'required-gates.json');
const DEFAULT_WORKFLOWS_DIR = path.join(REPO_ROOT, '.github', 'workflows');

// Matches a commented-out step anywhere under `jobs:`, e.g. `# - run: ...` or `#run: ...` or
// `      #   - uses: ...`.
const COMMENTED_STEP_RE = /^\s*#\s*-?\s*(run|uses):/;
// The top-level `jobs:` mapping key (allows a trailing comment, not a value on the same line).
const JOBS_HEADER_RE = /^jobs:\s*(#.*)?$/;
// Any line starting in column 0 with a non-space character ends the `jobs:` mapping (the next
// top-level key, e.g. `on:`, `permissions:`, or EOF).
const TOP_LEVEL_KEY_RE = /^\S/;
// A job id: exactly 2-space indented `<id>:` directly under `jobs:` (GitHub Actions workflows are
// always written this way; deeper indentation is a step/property of that job, not a new job).
const JOB_ID_RE = /^ {2}([A-Za-z0-9_-]+):\s*(#.*)?$/;

export interface Violation {
  readonly file: string;
  readonly line: number | undefined;
  readonly message: string;
}

function findWorkflowFiles(workflowsDir: string): readonly string[] {
  if (!existsSync(workflowsDir)) {
    return [];
  }
  return readdirSync(workflowsDir, { withFileTypes: true })
    .filter(
      (entry) =>
        !entry.isDirectory() && (entry.name.endsWith('.yml') || entry.name.endsWith('.yaml')),
    )
    .map((entry) => entry.name)
    .sort();
}

interface LineRange {
  readonly start: number;
  readonly end: number;
}

/** The half-open line range `[start, end)` of the `jobs:` mapping's body, or undefined if absent. */
function jobsSectionRange(lines: readonly string[]): LineRange | undefined {
  const start = lines.findIndex((line) => JOBS_HEADER_RE.test(line));
  if (start === -1) {
    return undefined;
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (TOP_LEVEL_KEY_RE.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  return { start, end };
}

function findCommentedSteps(fileName: string, lines: readonly string[]): Violation[] {
  const range = jobsSectionRange(lines);
  if (!range) {
    return [];
  }
  const violations: Violation[] = [];
  for (let i = range.start + 1; i < range.end; i += 1) {
    const line = lines[i] ?? '';
    if (COMMENTED_STEP_RE.test(line)) {
      violations.push({
        file: fileName,
        line: i + 1,
        message: `commented-out step inside 'jobs:' — ${line.trim()}`,
      });
    }
  }
  return violations;
}

function findJobIds(lines: readonly string[]): ReadonlySet<string> {
  const range = jobsSectionRange(lines);
  if (!range) {
    return new Set();
  }
  const ids = new Set<string>();
  for (let i = range.start + 1; i < range.end; i += 1) {
    const match = JOB_ID_RE.exec(lines[i] ?? '');
    const id = match?.[1];
    if (id !== undefined) {
      ids.add(id);
    }
  }
  return ids;
}

/**
 * Checks every workflow file under `workflowsDir` for hollowed-gate signals. `requiredGates` maps
 * workflow file name (e.g. `"ci.yml"`) to the job ids that must exist in it — a workflow file with
 * no entry in `requiredGates` is still scanned for commented-out steps, just not for missing jobs.
 * Exported so both the real CLI entrypoint below and the fixture self-test exercise the identical
 * logic against different directories.
 */
export function checkWorkflowsDir(
  workflowsDir: string,
  requiredGates: Readonly<Record<string, readonly string[]>>,
): Violation[] {
  const violations: Violation[] = [];
  const files = findWorkflowFiles(workflowsDir);

  for (const fileName of files) {
    const filePath = path.join(workflowsDir, fileName);
    const lines = readFileSync(filePath, 'utf8').split('\n');
    violations.push(...findCommentedSteps(fileName, lines));

    const required = requiredGates[fileName];
    if (!required) {
      continue;
    }
    const jobIds = findJobIds(lines);
    for (const jobId of required) {
      if (!jobIds.has(jobId)) {
        violations.push({
          file: fileName,
          line: undefined,
          message: `required job "${jobId}" (tools/arch-checks/required-gates.json) is missing from this workflow`,
        });
      }
    }
  }

  // A workflow file the manifest requires but that isn't on disk at all is itself a hollowing
  // signal (someone deleted the whole file instead of editing the manifest).
  for (const fileName of Object.keys(requiredGates)) {
    if (!files.includes(fileName)) {
      violations.push({
        file: fileName,
        line: undefined,
        message: 'workflow file required by tools/arch-checks/required-gates.json is missing',
      });
    }
  }

  return violations;
}

interface RawRequiredGatesManifest {
  readonly [key: string]: unknown;
}

function readRequiredGates(manifestPath: string): Record<string, readonly string[]> {
  const raw = readFileSync(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as RawRequiredGatesManifest;
  const manifest: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(parsed)) {
    // `_comment` is the manifest's own header note (required-gates.json), not a workflow entry.
    if (key.startsWith('_')) {
      continue;
    }
    if (!Array.isArray(value)) {
      throw new Error(`${manifestPath}: entry "${key}" must be an array of job ids`);
    }
    manifest[key] = value as readonly string[];
  }
  return manifest;
}

function reportViolations(violations: readonly Violation[]): void {
  console.error('gate-integrity: violations found:');
  for (const violation of violations) {
    const location =
      violation.line === undefined ? violation.file : `${violation.file}:${violation.line}`;
    console.error(`  ${location} — ${violation.message}`);
  }
}

function main(): number {
  const [, , workflowsDirArg, requiredGatesArg] = process.argv;
  const workflowsDir =
    workflowsDirArg !== undefined ? path.resolve(workflowsDirArg) : DEFAULT_WORKFLOWS_DIR;
  const requiredGatesPath =
    requiredGatesArg !== undefined ? path.resolve(requiredGatesArg) : DEFAULT_REQUIRED_GATES_PATH;

  const requiredGates = readRequiredGates(requiredGatesPath);
  const violations = checkWorkflowsDir(workflowsDir, requiredGates);

  if (violations.length === 0) {
    console.log('gate-integrity: no hollowed gates found.');
    return 0;
  }

  reportViolations(violations);
  return 1;
}

// Guarded so the fixture self-test can `import` this module's `checkWorkflowsDir` without also
// triggering a real-repo CLI run as a side effect.
if (import.meta.main) {
  process.exit(main());
}
