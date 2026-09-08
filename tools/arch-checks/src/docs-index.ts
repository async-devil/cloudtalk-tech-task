/**
 * `docs/README.md` is a generated index, and this is what generates it.
 *
 *   bun tools/arch-checks/src/docs-index.ts            # check: fails if the index is stale
 *   bun tools/arch-checks/src/docs-index.ts --write     # regenerate it
 *
 * It is two things at once, deliberately. The generator half means the index cannot drift from the
 * records — nobody hand-edits a table of twenty-one rows correctly forever. The checker half is
 * what makes that true in CI rather than in principle, and while it is already parsing every file's
 * frontmatter it validates the rest of the documentation contract for free: id/filename agreement,
 * sequential ids, the status vocabulary, the section order, and whether a task's `adr:` references
 * resolve to records that exist.
 *
 * The one thing it deliberately does NOT do is diff prose. An ADR that argues a trade-off and a
 * task that lists acceptance criteria are different documents, and the check for "is this in the
 * right folder" is a heuristic reported as a warning — a hard failure on a prose shape would be a
 * gate that is wrong often enough to be routinely overridden, which is worse than no gate.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

const DOCS_ROOT = new URL('../../../docs/', import.meta.url).pathname;
const INDEX_PATH = join(DOCS_ROOT, 'README.md');

const ADR_STATUSES = ['proposed', 'accepted', 'superseded', 'rejected'] as const;
const TASK_STATUSES = ['draft', 'ready', 'in-progress', 'done'] as const;

/** The frozen section order. A record whose headings differ is in the wrong shape, not merely
 * unconventional — the reading order in `CONTRIBUTING.md` depends on where each part is. */
const ADR_SECTIONS = ['Context', 'Decision', 'Consequences', 'Alternatives considered'] as const;
const TASK_SECTIONS = ['Scope', 'Out of scope', 'Acceptance criteria', 'Notes'] as const;

/** The folder each kind lives in. Singular kind, plural folder — spelled out once here rather
 * than concatenated at four call sites where one of them would eventually be wrong. */
const FOLDER = { adr: 'adr', task: 'tasks' } as const;

interface Record_ {
  readonly kind: 'adr' | 'task';
  readonly file: string;
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly date: string;
  readonly refs: readonly string[];
  readonly sections: readonly string[];
}

const problems: string[] = [];
const warnings: string[] = [];

function fail(file: string, message: string): void {
  problems.push(`${file}: ${message}`);
}

/**
 * A deliberately small frontmatter reader rather than a YAML dependency. The contract's schema is
 * five scalar keys and two flat lists; a full YAML parser would accept documents this contract does
 * not allow, which makes the checker weaker, not stronger.
 */
function parseFrontmatter(file: string, source: string): Map<string, string> | undefined {
  if (!source.startsWith('---\n')) {
    fail(file, 'no frontmatter block — the file must open with `---`');
    return undefined;
  }
  const end = source.indexOf('\n---\n', 4);
  if (end === -1) {
    fail(file, 'frontmatter block is never closed');
    return undefined;
  }
  const fields = new Map<string, string>();
  for (const line of source.slice(4, end).split('\n')) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    const separator = line.indexOf(':');
    if (separator === -1) {
      fail(file, `frontmatter line is not \`key: value\`: ${line}`);
      continue;
    }
    fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
  }
  return fields;
}

/** `[ADR-0002, ADR-0003]` -> `['ADR-0002', 'ADR-0003']`; `[]` -> `[]`. */
function parseList(raw: string | undefined): readonly string[] {
  if (raw === undefined) return [];
  const inner = raw.trim().replace(/^\[/, '').replace(/\]$/, '').trim();
  if (inner === '') return [];
  return inner.split(',').map((entry) => entry.trim());
}

function topLevelSections(source: string): readonly string[] {
  return source
    .split('\n')
    .filter((line) => line.startsWith('## '))
    .map((line) => line.slice(3).trim());
}

function read(kind: 'adr' | 'task', file: string): Record_ | undefined {
  const source = readFileSync(join(DOCS_ROOT, FOLDER[kind], file), 'utf8');
  const fields = parseFrontmatter(file, source);
  if (fields === undefined) return undefined;

  const prefix = kind === 'adr' ? 'ADR' : 'TASK';
  const id = fields.get('id') ?? '';
  const title = fields.get('title') ?? '';
  const status = fields.get('status') ?? '';
  const date = fields.get('date') ?? '';

  if (!new RegExp(`^${prefix}-\\d{4}$`).test(id)) {
    fail(file, `\`id\` must be \`${prefix}-NNNN\` with four digits, got \`${id}\``);
  }
  if (title === '') fail(file, '`title` is required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail(file, `\`date\` must be YYYY-MM-DD, got \`${date}\``);

  const allowed: readonly string[] = kind === 'adr' ? ADR_STATUSES : TASK_STATUSES;
  if (!allowed.includes(status)) {
    fail(file, `\`status\` must be one of ${allowed.join(' | ')}, got \`${status}\``);
  }

  // The filename carries the id so a directory listing is already an index, and so a link written
  // from an id resolves without a lookup. They must therefore agree.
  if (!file.startsWith(`${id}-`)) {
    fail(file, `filename must start with \`${id}-\``);
  }

  const sections = topLevelSections(source);
  const expected = kind === 'adr' ? ADR_SECTIONS : TASK_SECTIONS;
  if (sections.length !== expected.length || expected.some((name, i) => sections[i] !== name)) {
    fail(file, `sections must be exactly, in order: ${expected.join(' → ')}; found: ${sections.join(' → ') || '(none)'}`);
  }

  // The contract's one prose rule: an ADR records a decision, a task records work. A checklist in
  // an ADR and a trade-off argument in a task each mean the content is in the wrong folder. Warned,
  // never failed — see this file's header for why.
  const body = source.slice(source.indexOf('\n---\n', 4) + 5);
  if (kind === 'adr' && /^\s*-\s*\[[ x]\]/m.test(body)) {
    warnings.push(`${file}: contains a task checklist — a decision record should not carry to-dos`);
  }

  return {
    kind,
    file,
    id,
    title,
    status,
    date,
    refs: parseList(fields.get(kind === 'adr' ? 'supersedes' : 'adr')),
    sections,
  };
}

function collect(kind: 'adr' | 'task'): readonly Record_[] {
  const files = readdirSync(join(DOCS_ROOT, FOLDER[kind]))
    .filter((name) => name.endsWith('.md'))
    .sort();
  const records = files.flatMap((file) => read(kind, file) ?? []);

  // Ids are sequential and never reused, so a gap is either a deleted record (which the contract
  // forbids) or a typo. Either way it is worth a red build rather than a quiet hole in the index.
  records.forEach((record, index) => {
    const expected = `${kind === 'adr' ? 'ADR' : 'TASK'}-${String(index + 1).padStart(4, '0')}`;
    if (record.id !== expected) {
      fail(record.file, `ids must be sequential with no gaps — expected ${expected} here`);
    }
  });

  return records;
}

function renderIndex(adrs: readonly Record_[], tasks: readonly Record_[]): string {
  const adrRows = adrs
    .map((r) => `| [${r.id}](adr/${r.file}) | ${r.title} | ${r.status} | ${r.date} |`)
    .join('\n');
  const taskRows = tasks
    .map((r) => {
      const refs = r.refs.length === 0 ? '—' : r.refs.join(', ');
      return `| [${r.id}](tasks/${r.file}) | ${r.title} | ${r.status} | ${refs} |`;
    })
    .join('\n');

  return `# Documentation index

<!-- Generated by \`bun run docs-index -- --write\`. Do not edit by hand: CI regenerates this file
     and fails if it differs from what the records say. -->

This project tracks two kinds of document, kept strictly separate by intent.
[\`adr/\`](adr/) records a decision and its trade-offs — *why was it built this way*.
[\`tasks/\`](tasks/) records a unit of work and its acceptance criteria — *what needs doing, and how
we know it is done*. The brief this repository answers is in [\`assignment.md\`](assignment.md).

Before starting work: read this index, find the task with \`status: ready\`, read that task in full,
then read every ADR in its \`adr:\` field in full. Only then write code.

## Architecture decision records

| ID | Title | Status | Date |
|---|---|---|---|
${adrRows}

## Implementation tasks

| ID | Title | Status | Decisions |
|---|---|---|---|
${taskRows}

## Conventions

- Ids are sequential per folder, zero-padded to four digits, never reused or renumbered.
- ADRs are immutable once accepted. To change a decision, write a superseding record that names the
  one it replaces in its \`supersedes\` field.
- A task moves \`draft\` → \`ready\` → \`in-progress\` → \`done\`, and only one task is
  \`in-progress\` at a time.
- Completing a task flips its status and puts its id in the commit message.
`;
}

const adrs = collect('adr');
const tasks = collect('task');

// Cross-folder integrity: a task pointing at a record that does not exist is a reading-order
// instruction that dead-ends, which is the one failure the mandatory reading order cannot survive.
const adrIds = new Set(adrs.map((record) => record.id));
for (const task of tasks) {
  for (const ref of task.refs) {
    if (!adrIds.has(ref)) fail(task.file, `\`adr:\` names ${ref}, which does not exist`);
  }
}
for (const adr of adrs) {
  for (const ref of adr.refs) {
    if (!adrIds.has(ref)) fail(adr.file, `\`supersedes:\` names ${ref}, which does not exist`);
  }
  // A record can only be superseded by one that says so, and the superseded record must say it too
  // — otherwise a reader arriving from the index reads a decision that no longer holds.
  if (adr.refs.length > 0 && adr.status !== 'accepted') {
    fail(adr.file, 'a record that supersedes another must itself be accepted');
  }
}

const inProgress = tasks.filter((task) => task.status === 'in-progress');
if (inProgress.length > 1) {
  fail(
    'docs/tasks',
    `only one task may be in-progress at a time; found ${inProgress.map((t) => t.id).join(', ')}`,
  );
}

const expectedIndex = renderIndex(adrs, tasks);
const write = process.argv.includes('--write');

if (problems.length > 0) {
  console.error('Documentation contract violations:');
  for (const problem of problems) console.error(`  ${problem}`);
  if (warnings.length > 0) {
    console.error('Warnings:');
    for (const warning of warnings) console.error(`  ${warning}`);
  }
  process.exit(1);
}

if (write) {
  writeFileSync(INDEX_PATH, expectedIndex);
  console.log(`docs-index: wrote ${basename(INDEX_PATH)} (${adrs.length} ADRs, ${tasks.length} tasks)`);
} else {
  let actual = '';
  try {
    actual = readFileSync(INDEX_PATH, 'utf8');
  } catch {
    console.error('docs-index: docs/README.md does not exist. Run `bun run docs-index -- --write`.');
    process.exit(1);
  }
  if (actual !== expectedIndex) {
    console.error('docs-index: docs/README.md is stale. Run `bun run docs-index -- --write`.');
    process.exit(1);
  }
  console.log(`docs-index: index is current (${adrs.length} ADRs, ${tasks.length} tasks)`);
}

for (const warning of warnings) console.warn(`docs-index warning: ${warning}`);
