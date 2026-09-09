/**
 * The per-module telemetry-map gate (ADR-0009): every span and instrument a module emits is
 * listed in its README's `## Telemetry` section, and that section reconciles with the ADR or
 * task record it names as its source. A renamed span, a deleted counter, or an instrument added
 * without a corresponding doc line is otherwise invisible to CI.
 *
 * Spans AND instruments are in scope, the record-vs-README diff is checked, and `apps/*` are in
 * scope alongside `packages/*`.
 *
 * Five rules, evaluated per module (a `packages/*` or `apps/*` directory with a `src/`):
 *
 *  1. every emitted name has a `## Telemetry` line                        (code -> README)
 *  2. every `## Telemetry` line names something emitted                   (README -> code)
 *  3. a module that emits anything has a `## Telemetry` section at all
 *
 * Rules 4 and 5 — a name diff between the README and a linked source record, in both directions —
 * are DELIBERATELY NOT IMPLEMENTED here, and that is a narrowing worth stating rather than an
 * omission. They assume a document that enumerates a module's telemetry. This repository's
 * documentation contract has no such document: `docs/adr/` records decisions and their trade-offs,
 * `docs/tasks/` records units of work and their acceptance criteria, and neither is an inventory.
 * Satisfying those rules would mean pushing a list of instrument names into a decision record —
 * exactly the mixing of intent the contract forbids, and a list that would then need maintaining
 * in a file the contract also declares immutable.
 *
 * What survives is the half that catches drift: the code and the README must agree, both ways. A
 * span added without a README line fails, and a README line naming something no longer emitted
 * fails. The record link stays required, because a reader arriving at a telemetry table should be
 * one click from the decision that explains why those signals exist — it is just no longer diffed
 * name-by-name.
 *
 * Rules 2 and 4 are cleared per line by an **amendment marker** — `(amends <link>, YYYY-MM-DD:
 * <reason>)` — which is what keeps rule 4/5 from firing on every legitimate post-record change.
 * The marker does not silence the gate; it converts a divergence into a dated, reviewable record.
 * A name cited inside a marker also clears rule 5 for the record-side spelling it supersedes, so
 * a rename is recorded once, on one line, in both directions.
 *
 * What this gate deliberately does NOT do:
 *  - It compares NAME SETS, not kinds. A record that promises a span and a counter under one name
 *    is satisfied by either. Kind lives in the README's own prose/table for humans, unchecked.
 *  - It does not diff README prose against record prose — only the names are reconciled.
 *  - **Rule 5 sees only record names that are legal ADR-0009 names.** Both sides extract with the
 *    same `[a-z0-9-]` segment charset, so a spelling containing an underscore is invisible to it
 *    — deliberately: ADR-0011's DB identifiers are snake_case (`jobs.dead_letter.payload` is a
 *    COLUMN, not a telemetry name), so widening the charset would report every table reference in
 *    a doc as unemitted telemetry.
 *  - `withJobStageSpan`/`withBusEventSpan` (packages/messaging) build their names at runtime from
 *    a pipeline/stage/event type, so there is no literal to enumerate; they are named once in
 *    that module's README prose and are out of scope by design.
 *
 * Zero npm dependencies, following the no-core-logging.ts scanner pattern: plain line-matching
 * over `packages/*\/src/**` + `apps/*\/src/**`, never a TS parse.
 *
 * A module's `## Telemetry` section links its source record as a relative markdown link into
 * `docs/adr/` or `docs/tasks/` — this repo's own two durable record types, used here in place of
 * a dedicated design-spec folder.
 *
 * CLI: `bun tools/arch-checks/src/telemetry-map.ts [repoRoot]`. With no argument it checks the
 * real repo — this is what the `root:telemetry-map` moon task runs. The optional argument lets
 * the fixture self-test point the identical checker at fixture trees.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { PRODUCT_SOURCE_ROOTS } from './workspace-roots.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/**
 * ADR-0009's `{module}.{object}.{verb}`, restated. Source of truth is `SPAN_NAME_RE` in
 * `packages/observability/src/internal/naming.ts` — restated rather than imported because
 * `tools/arch-checks` takes no workspace dependencies (every sibling checker does the same).
 * Kept anchored for the whole-token test and re-used unanchored for backtick extraction.
 */
const NAME_BODY = '[a-z0-9-]+(?:\\.[a-z0-9-]+){2}';
const NAME_RE = new RegExp(`^${NAME_BODY}$`);
/** A name in backticks, as READMEs and records write it: `` `jobs.outbox.run` ``. */
const BACKTICKED_NAME_RE = new RegExp(`\`(${NAME_BODY})\``, 'g');
/** `observability.withSpan('name'` / `obs.withSpan("name"` — the only span-opening call. */
const WITH_SPAN_RE = /\bwithSpan\(\s*(['"])([^'"]+)\1/g;
/** An `InstrumentSpecification`'s `name:` property, inline in the call or on a named const. */
const INSTRUMENT_NAME_RE = /(?:^|[\s{,])name:\s*(['"])([^'"]+)\1/;
/** The cardinality-budget field every `InstrumentSpecification` carries (metrics.ts) — what tells
 * an instrument spec object apart from any other object with a `name` property. */
const ALLOWED_ATTRIBUTES_RE = /\ballowedAttributes\s*:/;
/**
 * How far from its `name:` the same object's `allowedAttributes:` may sit. The two are properties
 * of one Biome-formatted object literal (one property per line), so a handful of lines is
 * generous; exceeding it is reported (rule 6 below), never silently dropped — a checker that
 * quietly skips what it cannot parse is a hollowed gate.
 */
const INSTRUMENT_OBJECT_LOOKAHEAD = 10;
const INSTRUMENT_OBJECT_LOOKBEHIND = 4;

/**
 * The dated divergence record: `(amends <record link>, YYYY-MM-DD: <reason>)`. Matched
 * positionally — from the `(amends` opener to the end of the line — rather than to a closing `)`,
 * because the marker's own record link is a markdown link and carries parentheses of its own.
 * README entries are one per line, so end-of-line is the marker's true boundary.
 */
const AMENDMENT_OPENER = '(amends';
const AMENDMENT_DATE_RE = /\d{4}-\d{2}-\d{2}/;
/** A relative markdown link into `docs/adr/` or `docs/tasks/` — how a `## Telemetry` section
 * names its source record. */
const DESIGN_LINK_RE = /\]\(([^)\s]*docs\/(?:adr|tasks)\/[^)\s#]+\.md)(?:#[^)\s]*)?\)/g;

const TELEMETRY_HEADING = '## Telemetry';
const HEADING_RE = /^##\s+\S/;
const FENCE_RE = /^\s*```/;

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly message: string;
}

/** One name as the code emits it. */
interface Emission {
  readonly name: string;
  readonly kind: 'span' | 'instrument';
  readonly file: string;
  readonly line: number;
}

/** One `## Telemetry` line that declares a name. */
interface ReadmeEntry {
  readonly name: string;
  readonly line: number;
  /** Names cited inside this line's amendment marker — the record-side spellings it supersedes. */
  readonly supersedes: readonly string[];
  readonly hasAmendmentMarker: boolean;
}

interface TelemetrySection {
  readonly present: boolean;
  readonly headingLine: number;
  readonly entries: readonly ReadmeEntry[];
  readonly specLinks: readonly string[];
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
    if (entry.isFile() && entryPath.endsWith('.ts') && !entryPath.endsWith('.d.ts')) {
      files.push(entryPath);
    }
  }
  return files;
}

/** Every `packages/*` and `apps/*` directory that has a `src/` — the extraction-shaped unit. */
function discoverModules(repoRoot: string): { name: string; dir: string }[] {
  const modules: { name: string; dir: string }[] = [];
  for (const workspaceFolder of PRODUCT_SOURCE_ROOTS) {
    const folderPath = path.join(repoRoot, workspaceFolder);
    if (!existsSync(folderPath)) {
      continue;
    }
    for (const entry of readdirSync(folderPath, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const dir = path.join(folderPath, entry.name);
      if (existsSync(path.join(dir, 'src'))) {
        modules.push({ name: entry.name, dir });
      }
    }
  }
  return modules.sort((a, b) => a.dir.localeCompare(b.dir));
}

/**
 * Scans one module's `src/**` for the names it emits. Spans come from `withSpan('…'` literals;
 * instruments from an `InstrumentSpecification`'s `name:` property, identified by the
 * `allowedAttributes` field sitting in the same object literal. Anything shaped like an instrument
 * name that fails that co-location test is returned as a violation rather than dropped.
 */
function scanEmissions(
  repoRoot: string,
  moduleDir: string,
): { emissions: Emission[]; violations: Violation[] } {
  const emissions: Emission[] = [];
  const violations: Violation[] = [];

  for (const absolutePath of listTsFiles(path.join(moduleDir, 'src'))) {
    const relativePath = toPosix(path.relative(repoRoot, absolutePath));
    const lines = readFileSync(absolutePath, 'utf8').split('\n');

    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? '';

      WITH_SPAN_RE.lastIndex = 0;
      for (const match of line.matchAll(WITH_SPAN_RE)) {
        const name = match[2] ?? '';
        if (NAME_RE.test(name)) {
          emissions.push({ name, kind: 'span', file: relativePath, line: i + 1 });
        }
      }

      const instrumentMatch = INSTRUMENT_NAME_RE.exec(line);
      const candidate = instrumentMatch?.[2] ?? '';
      if (candidate === '' || !NAME_RE.test(candidate)) {
        continue;
      }
      const windowStart = Math.max(0, i - INSTRUMENT_OBJECT_LOOKBEHIND);
      const windowEnd = Math.min(lines.length, i + INSTRUMENT_OBJECT_LOOKAHEAD + 1);
      const hasAllowedAttributes = lines
        .slice(windowStart, windowEnd)
        .some((windowLine) => ALLOWED_ATTRIBUTES_RE.test(windowLine));
      if (!hasAllowedAttributes) {
        violations.push({
          file: relativePath,
          line: i + 1,
          message: `\`name: '${candidate}'\` is shaped like a telemetry name but no \`allowedAttributes\` sits within ${INSTRUMENT_OBJECT_LOOKBEHIND} lines above / ${INSTRUMENT_OBJECT_LOOKAHEAD} below, so this checker cannot tell whether it is an InstrumentSpecification. Keep the specification object contiguous (one property per line), or rename the field if it is not an instrument.`,
        });
        continue;
      }
      emissions.push({ name: candidate, kind: 'instrument', file: relativePath, line: i + 1 });
    }
  }

  return { emissions, violations };
}

/** Parses a README's `## Telemetry` section: its declared names, markers, and source-record links. */
function parseTelemetrySection(readmePath: string): TelemetrySection {
  if (!existsSync(readmePath)) {
    return { present: false, headingLine: 0, entries: [], specLinks: [] };
  }
  const lines = readFileSync(readmePath, 'utf8').split('\n');
  const entries: ReadmeEntry[] = [];
  const specLinks: string[] = [];
  let headingLine = 0;
  let inSection = false;
  let inFence = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';

    if (!inSection) {
      if (line.trim() === TELEMETRY_HEADING) {
        inSection = true;
        headingLine = i + 1;
      }
      continue;
    }
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    // The section runs to the next `## ` heading (`###` subsections stay inside it).
    if (!inFence && HEADING_RE.test(line)) {
      break;
    }
    if (inFence) {
      continue;
    }

    DESIGN_LINK_RE.lastIndex = 0;
    for (const linkMatch of line.matchAll(DESIGN_LINK_RE)) {
      const target = linkMatch[1];
      if (target !== undefined) {
        specLinks.push(target);
      }
    }

    BACKTICKED_NAME_RE.lastIndex = 0;
    const matches = [...line.matchAll(BACKTICKED_NAME_RE)];
    if (matches.length === 0) {
      continue;
    }
    // A marker counts only if it carries a date and a colon-introduced reason — `(amends …)` on
    // its own is an assertion, not a record.
    const openerIndex = line.indexOf(AMENDMENT_OPENER);
    const marker = openerIndex === -1 ? '' : line.slice(openerIndex);
    const hasAmendmentMarker =
      marker !== '' && AMENDMENT_DATE_RE.test(marker) && marker.includes(':');
    const markerStart = hasAmendmentMarker ? openerIndex : line.length;

    // The declared name is the first backticked name BEFORE the marker; names the marker cites are
    // superseded record-side spellings, not second declarations.
    const declaredMatch = matches.find((m) => (m.index ?? 0) < markerStart);
    if (declaredMatch === undefined) {
      continue;
    }
    const supersedes = matches
      .filter((m) => (m.index ?? 0) >= markerStart)
      .map((m) => m[1] ?? '')
      .filter((name) => name !== '');
    entries.push({
      name: declaredMatch[1] ?? '',
      line: i + 1,
      supersedes,
      hasAmendmentMarker,
    });
  }

  return { present: inSection, headingLine, entries, specLinks };
}

/** Every module-prefixed telemetry name a linked record mentions in backticks. */
function collectSpecNames(
  repoRoot: string,
  readmePath: string,
  specLinks: readonly string[],
  modulePrefix: string,
): { names: Map<string, string>; violations: Violation[] } {
  const names = new Map<string, string>();
  const violations: Violation[] = [];
  const readmeDisplay = toPosix(path.relative(repoRoot, readmePath));

  for (const link of specLinks) {
    const resolved = link.startsWith('/')
      ? path.join(repoRoot, link.slice(1))
      : path.resolve(path.dirname(readmePath), link);
    if (!existsSync(resolved)) {
      // A README link that does not resolve would otherwise make this gate silently compare
      // against an empty record, so it is reported here directly rather than assumed caught by
      // some other check.
      violations.push({
        file: readmeDisplay,
        line: 1,
        message: `\`## Telemetry\` source-record link "${link}" does not resolve to a file`,
      });
      continue;
    }
    const specDisplay = toPosix(path.relative(repoRoot, resolved));
    const content = readFileSync(resolved, 'utf8');
    BACKTICKED_NAME_RE.lastIndex = 0;
    for (const match of content.matchAll(BACKTICKED_NAME_RE)) {
      const name = match[1] ?? '';
      if (name.startsWith(`${modulePrefix}.`) && !names.has(name)) {
        names.set(name, specDisplay);
      }
    }
  }

  return { names, violations };
}

/** Distinct emitted names, first emission wins (a name may be both a span and an instrument). */
function emittedNamesOf(emissions: readonly Emission[]): Map<string, Emission> {
  const byName = new Map<string, Emission>();
  for (const emission of emissions) {
    if (!byName.has(emission.name)) {
      byName.set(emission.name, emission);
    }
  }
  return byName;
}

/**
 * The module-vs-facade-name gap: nothing requires a module's telemetry facade name
 * (`createModuleObservability(<name>)`) to match its package folder name, and a module may choose
 * a shorter or different telemetry namespace on purpose. Rather than special-case any one
 * package, this derives the real prefix STRUCTURALLY from what rule 1/2 already proved is
 * actually emitted: `assertModuleName` (ADR-0009, `@repo/observability`) rejects any span/
 * instrument whose first segment is not the exact string a module's own
 * `createModuleObservability` call was constructed with, so every name this scanner found for one
 * module carries the SAME first segment by construction — that segment IS the facade's real
 * module name, whether or not it matches the folder. Returns `undefined` (falling back to the
 * folder name) only for the pathological case of disagreeing prefixes, which `assertModuleName`
 * itself already makes unreachable at runtime.
 */
function emittedFacadePrefix(emittedNames: ReadonlyMap<string, Emission>): string | undefined {
  const prefixes = new Set(
    [...emittedNames.keys()].map((name) => name.slice(0, name.indexOf('.'))),
  );
  return prefixes.size === 1 ? [...prefixes][0] : undefined;
}

function checkModule(repoRoot: string, module: { name: string; dir: string }): Violation[] {
  const { emissions, violations } = scanEmissions(repoRoot, module.dir);
  const readmePath = path.join(module.dir, 'README.md');
  const readmeDisplay = toPosix(path.relative(repoRoot, readmePath));
  const section = parseTelemetrySection(readmePath);

  if (emissions.length === 0) {
    // Nothing emitted: no section required (rule 3 is scoped to emitters). A section that exists
    // anyway is still held to rule 2 — it must not claim emissions that do not exist.
    if (section.present) {
      for (const entry of section.entries) {
        if (!entry.hasAmendmentMarker) {
          violations.push({
            file: readmeDisplay,
            line: entry.line,
            message: `\`## Telemetry\` lists \`${entry.name}\`, but ${module.name} emits no telemetry at all`,
          });
        }
      }
    }
    return violations;
  }

  if (!section.present) {
    const first = emissions[0];
    const count = emittedNamesOf(emissions).size;
    violations.push({
      file: readmeDisplay,
      line: 1,
      message: `${module.name} emits ${count} telemetry ${count === 1 ? 'name' : 'names'} (e.g. \`${first?.name}\` at ${first?.file}:${first?.line}) but the README has no \`${TELEMETRY_HEADING}\` section`,
    });
    return violations;
  }

  const declaredNames = new Set(section.entries.map((entry) => entry.name));
  const emittedNames = emittedNamesOf(emissions);

  // Rule 1 — code -> README.
  for (const [name, emission] of emittedNames) {
    if (!declaredNames.has(name)) {
      violations.push({
        file: readmeDisplay,
        line: section.headingLine,
        message: `${emission.kind} \`${name}\` is emitted at ${emission.file}:${emission.line} but has no \`${TELEMETRY_HEADING}\` line`,
      });
    }
  }

  // Rule 2 — README -> code.
  for (const entry of section.entries) {
    if (!emittedNames.has(entry.name) && !entry.hasAmendmentMarker) {
      violations.push({
        file: readmeDisplay,
        line: entry.line,
        message: `\`${TELEMETRY_HEADING}\` lists \`${entry.name}\`, which ${module.name} does not emit — remove the line, or record why it survives with an \`(amends <record link>, YYYY-MM-DD: <reason>)\` marker`,
      });
    }
  }

  if (section.specLinks.length === 0) {
    violations.push({
      file: readmeDisplay,
      line: section.headingLine,
      message: `\`${TELEMETRY_HEADING}\` names no source record — link the owning ADR or task record (a relative link into docs/adr/ or docs/tasks/) so the record-vs-README diff has something to reconcile against`,
    });
    return violations;
  }

  return violations;
}

/**
 * Checks every module under `repoRoot` for telemetry-map violations. Exported so the fixture
 * self-test and the real-CLI entrypoint below share identical logic against different
 * directories.
 */
export function checkTelemetryMap(repoRoot: string): Violation[] {
  const violations: Violation[] = [];
  for (const module of discoverModules(repoRoot)) {
    violations.push(...checkModule(repoRoot, module));
  }
  return violations;
}

function main(): number {
  const [, , repoRootArg] = process.argv;
  const repoRoot = repoRootArg !== undefined ? path.resolve(repoRootArg) : REPO_ROOT;
  const violations = checkTelemetryMap(repoRoot);
  if (violations.length === 0) {
    console.log('telemetry-map: every emitted span/instrument is documented and reconciled.');
    return 0;
  }
  console.error('telemetry-map: violations found:');
  for (const violation of violations) {
    console.error(`  ${violation.file}:${violation.line} — ${violation.message}`);
  }
  return 1;
}

// Guarded so the fixture self-test can `import` this module's exports without also triggering a
// real-repo run as a side effect (mirrors gate-integrity.ts).
if (import.meta.main) {
  process.exit(main());
}
