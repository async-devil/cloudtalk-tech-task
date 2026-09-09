/**
 * The ADR-0011 migration-DDL gate ("Database naming and structure conventions"; ADR-0006's data
 * lifecycle registry extension). Parses every migration file's hand-written SQL and fails on the
 * rule list both ADRs name (see the `RULE` catalog below — one id per bullet, so a fixture can
 * target exactly one).
 *
 * Zero npm dependencies, following the gate-integrity/no-core-logging scanner pattern: migrations
 * in this repo are hand-written, short, and structurally uniform (ADR-0006) — one SQL statement
 * per `` sql`...` `` tagged-template call (`packages/persistence/migrations/0002-create-jobs-spine.ts`,
 * `packages/persistence/migrations/0001-create-persistence-bootstrap.ts` are the worked examples) —
 * so a small hand-rolled statement scanner (balanced-paren column-list splitting, prefix regexes
 * for statement kind) covers the real shapes without a SQL-parser dependency.
 *
 * Discovery: every `packages/*\/migrations/*.ts` and `apps/*\/migrations/*.ts` file matching
 * ADR-0006's `NNNN-description.(ts|js)` name (the same `MIGRATION_FILE_RE` shape
 * `packages/persistence/src/internal/collect-migrations.ts` uses — duplicated, not imported: this
 * package is `tier-tooling` and may not depend on a workspace module, see the file-local note on
 * {@link GRANDFATHERED_MIGRATIONS} for the one other place this file intentionally does not reach
 * into `@repo/persistence`).
 *
 * {@link GRANDFATHERED_MIGRATIONS} is currently EMPTY, so every migration in the tree is checked.
 * The set is retained as the named, ADR-sanctioned exemption seam for a future migration that must
 * be excused from these DDL rules — never a wildcard.
 *
 * CLI: `bun tools/arch-checks/src/migration-ddl.ts [repoRoot]`. With no arguments it checks the
 * real repo — this is what the `root:migration-ddl` moon task / CI job runs. The optional argument
 * lets the fixture self-test point the identical checker at a fixture directory.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  LIFECYCLE_CLASS,
  type LifecycleRegistryRow,
  REGISTRY,
} from './data-lifecycle-registry.cjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const REPO_ROOT = path.resolve(PACKAGE_ROOT, '..', '..');

/** ADR-0006's exact migration file name shape, duplicated from `collect-migrations.ts` (a
 * `tier-tooling` package may not import a workspace module — `.dependency-cruiser.cjs`'s
 * `tier-direction` rule gives `arch-checks` zero allowed targets; "tools operate on the repo as
 * data", not as code they execute). */
const MIGRATION_FILE_RE = /^(\d+)-.+\.(?:ts|js)$/;

/** The named, ADR-sanctioned exemption seam. See file header. Never a wildcard. */
const GRANDFATHERED_MIGRATIONS: ReadonlySet<string> = new Set([]);

/**
 * Tables whose primary-key column is a third-party library's, exempt from the
 * `entity-pk-not-table-id` rule — a sanctioned per-column allowlist entry in the migration-DDL
 * gate. better-auth 1.6.23 names the primary-key column `id` unconditionally (not mappable
 * through its public `<model>.fields` config); the four library tables keep it, confined to the
 * `auth` schema. Domain tables reference `auth.app_user.app_user_id` (ours, `<table>_id`-shaped
 * and therefore NOT on this list), never a library-minted identifier. Only the PK-column-name
 * rule is relaxed; the columns are still `uuid DEFAULT uuidv7()`, named/indexed, and every other
 * ADR-0011 rule applies unchanged. See `packages/persistence/migrations/0003-create-auth.ts`'s
 * header for the fuller rationale.
 */
const LIBRARY_OWNED_PK_TABLES: ReadonlySet<string> = new Set([
  'auth.identity',
  'auth.session',
  'auth.account',
  'auth.verification',
]);

// -------------------------------------------------------------------------------------------
// Rule ids — one per fixture, one per ADR-0011/ADR-0006 bullet (each rule must go red on a
// fixture migration of its own).
// -------------------------------------------------------------------------------------------
export const RULE = {
  IdentifierTooLong: 'identifier-too-long',
  ConstraintUnnamed: 'constraint-unnamed',
  ConstraintNamePattern: 'constraint-name-pattern',
  ReservedWord: 'reserved-word',
  AbbreviationDenied: 'abbreviation-denied',
  PluralTableName: 'plural-table-name',
  EntityPkNotTableId: 'entity-pk-not-table-id',
  IfNotExistsBanned: 'if-not-exists-banned',
  EnumTypeBanned: 'enum-type-banned',
  ClusterStatementInRunnerMigration: 'cluster-statement-in-runner-migration',
  NonClusterStatementInRootMigration: 'non-cluster-statement-in-root-migration',
  MultipleRootMigrations: 'multiple-root-migrations',
  InsertInRootMigration: 'insert-in-root-migration',
  TimestampWithoutTimezone: 'timestamp-without-timezone',
  NullableBoolean: 'nullable-boolean',
  UpdatedAtWithoutTrigger: 'updated-at-without-trigger',
  StorageParameterDefault: 'storage-parameter-default',
  InsertIntoNonReferenceTable: 'insert-into-non-reference-table',
  LifecycleRegistryMissingRow: 'lifecycle-registry-missing-row',
  LifecycleRegistryEvidenceNoHorizon: 'lifecycle-registry-evidence-no-horizon',
  LifecycleRegistryStaleEntry: 'lifecycle-registry-stale-entry',
} as const;
export type RuleId = (typeof RULE)[keyof typeof RULE];

export interface Violation {
  readonly rule: RuleId;
  readonly file: string;
  readonly message: string;
}

// -------------------------------------------------------------------------------------------
// Reserved words / abbreviation deny-list.
//
// ADR-0011 names "the reserved-word list" and "an abbreviation from the deny-list" as if both
// already exist as enumerated lists. Neither does: the ADR states the principle ("no
// abbreviations", full words) but names no list, and no reserved-word list exists anywhere in
// docs/. This gate cannot leave the rule unimplemented or invent an arbitrary list divorced from
// the repo's own words, so both lists below are built strictly from sources already in this
// repo's docs, cited per entry:
//   - reserved words: PostgreSQL 18's own reserved-keyword class — the practical subset likely to
//     collide with a hand-picked table/column name, not the full ~470-keyword appendix.
//   - abbreviations: ADR-0011's own worked examples ("organization, not org"; "basis_points, not
//     bps") plus the kept-exception list it states verbatim ("id, url, iso, vat... stay as-is") —
//     nothing added that the ADR text itself did not already name or clearly analogize.
// This is a rule the ADR specifies incompletely, not a gate bug.
// -------------------------------------------------------------------------------------------
const RESERVED_WORDS: ReadonlySet<string> = new Set([
  'user',
  'order',
  'group',
  'table',
  'column',
  'select',
  'where',
  'check',
  'unique',
  'primary',
  'foreign',
  'references',
  'constraint',
  'default',
  'null',
  'not',
  'and',
  'or',
  'like',
  'in',
  'is',
  'as',
  'on',
  'join',
  'union',
  'case',
  'when',
  'then',
  'else',
  'end',
  'all',
  'any',
  'some',
  'exists',
  'grant',
  'role',
  'to',
  'from',
  'into',
  'values',
  'insert',
  'update',
  'delete',
  'create',
  'drop',
  'alter',
  'index',
  'view',
  'trigger',
  'function',
  'schema',
  'database',
  'transaction',
  'commit',
  'rollback',
  'limit',
  'offset',
  'having',
  'distinct',
  'cast',
  'collate',
  'true',
  'false',
  'array',
  'binary',
  'both',
  'leading',
  'trailing',
  'localtime',
  'localtimestamp',
  'current_date',
  'current_time',
  'current_timestamp',
  'current_user',
  'session_user',
]);

// The kept exceptions ADR-0011 names verbatim: "id, url, iso, vat" — never flagged even though
// short, because the ADR itself carves them out.
const KEPT_ABBREVIATIONS: ReadonlySet<string> = new Set(['id', 'url', 'iso', 'vat']);

// ADR-0011's own worked examples ("organization, not org"; "basis_points, not bps") plus the
// same small family of unambiguous DB-naming abbreviations (attribute/description/quantity/amount/
// number/parameter/message/address) — never a real dictionary word, never one of the kept tokens.
const DENIED_ABBREVIATIONS: ReadonlySet<string> = new Set([
  'org',
  'bps',
  'addr',
  'desc',
  'msg',
  'msgs',
  'qty',
  'amt',
  'num',
  'attr',
  'param',
  'params',
]);

// Nouns that legitimately end in "s" while singular (so the plural-table check doesn't fire on
// them) — drawn from this spec's own vocabulary (`status`) plus the couple of common false
// positives a naive "ends with s" heuristic would otherwise hit.
const SINGULAR_S_ALLOWLIST: ReadonlySet<string> = new Set([
  'status',
  'address',
  'series',
  'species',
  'analysis',
]);

function isPlural(word: string): boolean {
  const lower = word.toLowerCase();
  if (SINGULAR_S_ALLOWLIST.has(lower)) {
    return false;
  }
  if (
    !lower.endsWith('s') ||
    lower.endsWith('ss') ||
    lower.endsWith('us') ||
    lower.endsWith('is')
  ) {
    return false;
  }
  return true;
}

// -------------------------------------------------------------------------------------------
// Migration discovery
// -------------------------------------------------------------------------------------------
export interface MigrationFile {
  readonly absolutePath: string;
  /** posix, relative to the scanned root. */
  readonly relativePath: string;
  readonly fileName: string;
  /** The leading digit run in the file name, verbatim (e.g. "0", "0001"). */
  readonly indexToken: string;
  /** True iff {@link indexToken} strips to the empty string under leading-zero removal — i.e. it
   * denotes ADR-0011's index `0` (root/cluster) migration, however many digits it is padded to
   * ("0", "0000", ... are all index 0; "0001" is not). */
  readonly isRootMigration: boolean;
}

function toPosix(p: string): string {
  return p.split(path.sep).join('/');
}

function listMigrationFilesIn(dir: string): string[] {
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && MIGRATION_FILE_RE.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

export interface DiscoverMigrationFilesOptions {
  /** A live-database introspection tool needs the REAL, runnable migration set (grandfathered
   * migrations still apply to a live database and still exist in the running schema); the DDL
   * rule checks above deliberately skip them (see the file header). @default false */
  readonly includeGrandfathered?: boolean;
}

/** `packages/*\/migrations/*.ts|js` and `apps/*\/migrations/*.ts|js`, excluding
 * {@link GRANDFATHERED_MIGRATIONS} unless `options.includeGrandfathered` is set. Exported so any
 * future introspection checker can reuse identical discovery logic against a live scratch
 * database. */
export function discoverMigrationFiles(
  repoRoot: string,
  options: DiscoverMigrationFilesOptions = {},
): MigrationFile[] {
  const files: MigrationFile[] = [];
  for (const workspaceFolder of ['packages', 'apps']) {
    const folderPath = path.join(repoRoot, workspaceFolder);
    if (!existsSync(folderPath)) {
      continue;
    }
    for (const moduleEntry of readdirSync(folderPath, { withFileTypes: true })) {
      if (!moduleEntry.isDirectory()) {
        continue;
      }
      const migrationsDir = path.join(folderPath, moduleEntry.name, 'migrations');
      for (const fileName of listMigrationFilesIn(migrationsDir)) {
        const absolutePath = path.join(migrationsDir, fileName);
        const relativePath = toPosix(path.relative(repoRoot, absolutePath));
        if (!options.includeGrandfathered && GRANDFATHERED_MIGRATIONS.has(relativePath)) {
          continue;
        }
        // biome-ignore lint/style/noNonNullAssertion: MIGRATION_FILE_RE has exactly one capture group, tested true by listMigrationFilesIn's own filter
        const indexToken = MIGRATION_FILE_RE.exec(fileName)![1]!;
        files.push({
          absolutePath,
          relativePath,
          fileName,
          indexToken,
          isRootMigration: indexToken.replace(/^0+/, '') === '',
        });
      }
    }
  }
  return files.sort((a, b) =>
    a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0,
  );
}

// -------------------------------------------------------------------------------------------
// SQL extraction: every `` sql`...` `` tagged-template body inside a migration's `up()` (ADR-0006:
// hand-written, one statement per call — see the file header for the worked examples this shape
// is read from).
// -------------------------------------------------------------------------------------------
export interface Statement {
  readonly file: MigrationFile;
  readonly sql: string;
}

const SQL_TEMPLATE_RE = /\bsql`([^`]*)`/gs;

function extractStatements(file: MigrationFile): Statement[] {
  const text = readFileSync(file.absolutePath, 'utf8');
  const statements: Statement[] = [];
  for (const match of text.matchAll(SQL_TEMPLATE_RE)) {
    const body = match[1];
    if (body === undefined) {
      continue;
    }
    const trimmed = body.trim();
    if (trimmed.length > 0) {
      statements.push({ file, sql: trimmed });
    }
  }
  return statements;
}

// -------------------------------------------------------------------------------------------
// Balanced-paren / top-level-split helpers (SQL text, single-quoted string literals respected).
// -------------------------------------------------------------------------------------------
function findMatchingParen(text: string, openIndex: number): number {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  throw new Error(`migration-ddl: unbalanced parentheses from index ${openIndex}`);
}

function splitTopLevelCommas(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString = false;
  let current = '';
  for (const ch of text) {
    if (ch === "'") {
      inString = !inString;
      current += ch;
      continue;
    }
    if (!inString) {
      if (ch === '(') {
        depth += 1;
      } else if (ch === ')') {
        depth -= 1;
      }
    }
    if (ch === ',' && depth === 0 && !inString) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim().length > 0) {
    parts.push(current);
  }
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

// -------------------------------------------------------------------------------------------
// Structural records
// -------------------------------------------------------------------------------------------
interface ConstraintItem {
  readonly kind: 'PK' | 'FK' | 'UNIQUE' | 'CHECK';
  /** undefined = no `CONSTRAINT <name>` clause at all (unnamed). */
  readonly name: string | undefined;
  readonly columns: readonly string[];
  readonly raw: string;
}

interface ColumnItem {
  readonly name: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly raw: string;
}

interface CreateTableRecord {
  readonly statement: Statement;
  readonly schema: string;
  readonly table: string;
  readonly qualifiedName: string;
  readonly columns: readonly ColumnItem[];
  readonly constraints: readonly ConstraintItem[];
  readonly tail: string;
  readonly identifiers: readonly string[];
}

interface CreateIndexRecord {
  readonly statement: Statement;
  readonly name: string | undefined;
  readonly schema: string;
  readonly table: string;
  readonly columns: readonly string[];
  /** `CREATE UNIQUE INDEX` — named `uq_…`, not `ix_…` (ADR-0011: "uq_ covers both; whether it is
   * expressed as a constraint or a unique index is a mechanical detail, not a naming one"). */
  readonly unique: boolean;
}

interface CreateTriggerRecord {
  readonly statement: Statement;
  readonly name: string;
  readonly schema: string;
  readonly table: string;
}

interface InsertRecord {
  readonly statement: Statement;
  readonly schema: string | undefined;
  readonly table: string;
}

const CONSTRAINT_PREFIX_RE = /^CONSTRAINT\s+(\S+)\s+(PRIMARY\s+KEY|FOREIGN\s+KEY|UNIQUE|CHECK)\b/i;

function constraintKindFrom(token: string): ConstraintItem['kind'] {
  const normalized = token.toUpperCase().replace(/\s+/g, ' ');
  if (normalized === 'PRIMARY KEY') return 'PK';
  if (normalized === 'FOREIGN KEY') return 'FK';
  if (normalized === 'UNIQUE') return 'UNIQUE';
  return 'CHECK';
}

function extractParenColumns(text: string): string[] {
  const openIndex = text.indexOf('(');
  if (openIndex === -1) {
    return [];
  }
  const closeIndex = findMatchingParen(text, openIndex);
  return splitTopLevelCommas(text.slice(openIndex + 1, closeIndex)).map((col) =>
    // Strip a trailing sort/opclass token (e.g. "created_at DESC") down to the bare column name.
    (col.split(/\s+/)[0] ?? col).trim(),
  );
}

/** Parses one top-level item from a `CREATE TABLE (...)` body into either a named/unnamed
 * constraint or a column definition (which may itself carry an INLINE unnamed constraint —
 * `id uuid PRIMARY KEY`, `col uuid REFERENCES other (id)`, `col text CHECK (col <> '')`). */
function parseTableItem(raw: string): { column?: ColumnItem; constraints: ConstraintItem[] } {
  const trimmed = raw.trim();

  const namedMatch = CONSTRAINT_PREFIX_RE.exec(trimmed);
  if (namedMatch) {
    const name = namedMatch[1];
    const kindToken = namedMatch[2];
    if (name === undefined || kindToken === undefined) {
      throw new Error('migration-ddl: CONSTRAINT_PREFIX_RE matched without its capture groups');
    }
    const kind = constraintKindFrom(kindToken);
    const columns =
      kind === 'CHECK' ? [] : extractParenColumns(trimmed.slice(namedMatch[0].length));
    return { constraints: [{ kind, name, columns, raw: trimmed }] };
  }

  if (/^PRIMARY\s+KEY\s*\(/i.test(trimmed)) {
    return {
      constraints: [
        { kind: 'PK', name: undefined, columns: extractParenColumns(trimmed), raw: trimmed },
      ],
    };
  }
  if (/^FOREIGN\s+KEY\s*\(/i.test(trimmed)) {
    return {
      constraints: [
        { kind: 'FK', name: undefined, columns: extractParenColumns(trimmed), raw: trimmed },
      ],
    };
  }
  if (/^UNIQUE\s*\(/i.test(trimmed)) {
    return {
      constraints: [
        { kind: 'UNIQUE', name: undefined, columns: extractParenColumns(trimmed), raw: trimmed },
      ],
    };
  }
  if (/^CHECK\s*\(/i.test(trimmed)) {
    return { constraints: [{ kind: 'CHECK', name: undefined, columns: [], raw: trimmed }] };
  }

  // A column definition. Extract name + type, and detect inline (unnamed) constraints riding on
  // it (e.g. `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`).
  const spaceIndex = trimmed.search(/\s/);
  const name = spaceIndex === -1 ? trimmed : trimmed.slice(0, spaceIndex);
  const rest = spaceIndex === -1 ? '' : trimmed.slice(spaceIndex + 1).trim();
  const modifierRe = /\b(NOT\s+NULL|NULL|DEFAULT|PRIMARY\s+KEY|REFERENCES|CHECK|UNIQUE)\b/i;
  const modifierMatch = modifierRe.exec(rest);
  const type = (modifierMatch ? rest.slice(0, modifierMatch.index) : rest).trim();
  const notNull = /\bNOT\s+NULL\b/i.test(rest);

  const inlineConstraints: ConstraintItem[] = [];
  if (/\bPRIMARY\s+KEY\b/i.test(rest)) {
    inlineConstraints.push({ kind: 'PK', name: undefined, columns: [name], raw: trimmed });
  }
  if (/\bREFERENCES\b/i.test(rest)) {
    inlineConstraints.push({ kind: 'FK', name: undefined, columns: [name], raw: trimmed });
  }
  if (/\bUNIQUE\b/i.test(rest)) {
    inlineConstraints.push({ kind: 'UNIQUE', name: undefined, columns: [name], raw: trimmed });
  }
  if (/\bCHECK\s*\(/i.test(rest)) {
    inlineConstraints.push({ kind: 'CHECK', name: undefined, columns: [], raw: trimmed });
  }

  return { column: { name, type, notNull, raw: trimmed }, constraints: inlineConstraints };
}

function parseCreateTable(statement: Statement): CreateTableRecord | undefined {
  const match = /^CREATE\s+TABLE\s+([A-Za-z0-9_.]+)\s*\(/i.exec(statement.sql);
  if (!match) {
    return undefined;
  }
  const qualifiedName = match[1];
  if (qualifiedName === undefined) {
    return undefined;
  }
  const openIndex = statement.sql.indexOf('(', match.index);
  const closeIndex = findMatchingParen(statement.sql, openIndex);
  const body = statement.sql.slice(openIndex + 1, closeIndex);
  const tail = statement.sql.slice(closeIndex + 1);

  const [schema, table] = qualifiedName.includes('.')
    ? qualifiedName.split('.', 2)
    : [undefined, qualifiedName];
  if (table === undefined) {
    return undefined;
  }

  const columns: ColumnItem[] = [];
  const constraints: ConstraintItem[] = [];
  const identifiers: string[] = [qualifiedName, table];
  if (schema !== undefined) {
    identifiers.push(schema);
  }

  for (const item of splitTopLevelCommas(body)) {
    const parsed = parseTableItem(item);
    if (parsed.column) {
      columns.push(parsed.column);
      identifiers.push(parsed.column.name);
    }
    for (const constraint of parsed.constraints) {
      constraints.push(constraint);
      if (constraint.name !== undefined) {
        identifiers.push(constraint.name);
      }
    }
  }

  return {
    statement,
    schema: schema ?? '',
    table,
    qualifiedName,
    columns,
    constraints,
    tail,
    identifiers,
  };
}

function parseCreateIndex(statement: Statement): CreateIndexRecord | undefined {
  const match =
    /^CREATE\s+(UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?([A-Za-z0-9_]+)?\s*ON\s+([A-Za-z0-9_.]+)\s*\(/is.exec(
      statement.sql,
    );
  if (!match) {
    return undefined;
  }
  const qualifiedName = match[3];
  if (qualifiedName === undefined) {
    return undefined;
  }
  const [schema, table] = qualifiedName.includes('.')
    ? qualifiedName.split('.', 2)
    : ['', qualifiedName];
  const openIndex = statement.sql.indexOf('(', match.index + match[0].length - 1);
  const columns = extractParenColumns(statement.sql.slice(openIndex));
  return {
    statement,
    name: match[2],
    schema: schema ?? '',
    table: table ?? qualifiedName,
    columns,
    unique: match[1] !== undefined,
  };
}

function parseCreateTrigger(statement: Statement): CreateTriggerRecord | undefined {
  const match = /^CREATE\s+TRIGGER\s+([A-Za-z0-9_]+)\s+.*?\bON\s+([A-Za-z0-9_.]+)/is.exec(
    statement.sql,
  );
  if (!match) {
    return undefined;
  }
  const name = match[1];
  const qualifiedName = match[2];
  if (name === undefined || qualifiedName === undefined) {
    return undefined;
  }
  const [schema, table] = qualifiedName.includes('.')
    ? qualifiedName.split('.', 2)
    : ['', qualifiedName];
  return { statement, name, schema: schema ?? '', table: table ?? qualifiedName };
}

function parseInsert(statement: Statement): InsertRecord | undefined {
  const match = /^INSERT\s+INTO\s+([A-Za-z0-9_.]+)/i.exec(statement.sql);
  if (!match) {
    return undefined;
  }
  const qualifiedName = match[1];
  if (qualifiedName === undefined) {
    return undefined;
  }
  const [schema, table] = qualifiedName.includes('.')
    ? qualifiedName.split('.', 2)
    : [undefined, qualifiedName];
  return { statement, schema, table: table ?? qualifiedName };
}

// -------------------------------------------------------------------------------------------
// Constraint / index / trigger naming pattern (ADR-0011).
// -------------------------------------------------------------------------------------------
const NAME_PREFIX: Record<'PK' | 'FK' | 'UNIQUE' | 'CHECK' | 'INDEX' | 'TRIGGER', string> = {
  PK: 'pk_',
  FK: 'fk_',
  UNIQUE: 'uq_',
  CHECK: 'ck_',
  INDEX: 'ix_',
  TRIGGER: 'tg_',
};

function matchesNamePattern(kind: keyof typeof NAME_PREFIX, name: string, table: string): boolean {
  const prefix = NAME_PREFIX[kind];
  const lowerName = name.toLowerCase();
  if (!lowerName.startsWith(prefix)) {
    return false;
  }
  const rest = lowerName.slice(prefix.length);
  const lowerTable = table.toLowerCase();
  if (kind === 'PK') {
    return rest === lowerTable;
  }
  if (!rest.startsWith(lowerTable)) {
    return false;
  }
  const remainder = rest.slice(lowerTable.length);
  return remainder.startsWith('__') && remainder.length > 2;
}

// -------------------------------------------------------------------------------------------
// Cluster-level statement classification (ADR-0011). `COMMENT ON ROLE` is included: a role is a
// cluster-scoped object (its comment is stored cluster-wide in pg_shdescription), so commenting
// one is cluster-level by the same reasoning that puts CREATE ROLE here — and the root
// migration's role DDL is required to carry its own COMMENTs like any other reviewed DDL.
// -------------------------------------------------------------------------------------------
const CLUSTER_STATEMENT_RE =
  /^(CREATE\s+DATABASE|ALTER\s+SYSTEM|CREATE\s+ROLE|COMMENT\s+ON\s+ROLE)\b/i;

// Storage parameters whose PostgreSQL engine default is the value below (ADR-0011: "do not
// restate defaults"). Keys are compared case-insensitively; values compared after lowercasing and
// stripping surrounding quotes.
const DEFAULT_STORAGE_PARAMS: Readonly<Record<string, string>> = {
  fillfactor: '100',
  autovacuum_enabled: 'true',
  'toast.autovacuum_enabled': 'true',
};

function parseStorageParams(tail: string): Array<{ key: string; value: string }> {
  const match = /\bWITH\s*\(/i.exec(tail);
  if (!match) {
    return [];
  }
  const openIndex = tail.indexOf('(', match.index);
  const closeIndex = findMatchingParen(tail, openIndex);
  const body = tail.slice(openIndex + 1, closeIndex);
  return splitTopLevelCommas(body).flatMap((entry) => {
    const eqIndex = entry.indexOf('=');
    if (eqIndex === -1) {
      return [];
    }
    const key = entry.slice(0, eqIndex).trim();
    const value = entry
      .slice(eqIndex + 1)
      .trim()
      .replace(/^['"]|['"]$/g, '');
    return [{ key, value }];
  });
}

// -------------------------------------------------------------------------------------------
// Orchestration
// -------------------------------------------------------------------------------------------
interface ParsedTree {
  readonly files: readonly MigrationFile[];
  readonly statements: readonly Statement[];
  readonly tables: readonly CreateTableRecord[];
  readonly indexes: readonly CreateIndexRecord[];
  readonly triggers: readonly CreateTriggerRecord[];
  readonly inserts: readonly InsertRecord[];
}

function parseAll(repoRoot: string): ParsedTree {
  const files = discoverMigrationFiles(repoRoot);
  const statements = files.flatMap((file) => extractStatements(file));
  const tables: CreateTableRecord[] = [];
  const indexes: CreateIndexRecord[] = [];
  const triggers: CreateTriggerRecord[] = [];
  const inserts: InsertRecord[] = [];

  for (const statement of statements) {
    const table = parseCreateTable(statement);
    if (table) {
      tables.push(table);
      continue;
    }
    const index = parseCreateIndex(statement);
    if (index) {
      indexes.push(index);
      continue;
    }
    const trigger = parseCreateTrigger(statement);
    if (trigger) {
      triggers.push(trigger);
      continue;
    }
    const insert = parseInsert(statement);
    if (insert) {
      inserts.push(insert);
    }
  }

  return { files, statements, tables, indexes, triggers, inserts };
}

function relFile(statement: Statement): string {
  return statement.file.relativePath;
}

// --- Rule implementations -------------------------------------------------------------------

function checkIdentifierLength(tree: ParsedTree): Violation[] {
  const violations: Violation[] = [];
  for (const table of tree.tables) {
    for (const identifier of table.identifiers) {
      if (Buffer.byteLength(identifier, 'utf8') > 63) {
        violations.push({
          rule: RULE.IdentifierTooLong,
          file: relFile(table.statement),
          message: `identifier "${identifier}" is ${Buffer.byteLength(identifier, 'utf8')} bytes (PostgreSQL truncates silently past 63) — ADR-0011`,
        });
      }
    }
  }
  for (const index of tree.indexes) {
    if (index.name !== undefined && Buffer.byteLength(index.name, 'utf8') > 63) {
      violations.push({
        rule: RULE.IdentifierTooLong,
        file: relFile(index.statement),
        message: `index identifier "${index.name}" exceeds 63 bytes — ADR-0011`,
      });
    }
  }
  for (const trigger of tree.triggers) {
    if (Buffer.byteLength(trigger.name, 'utf8') > 63) {
      violations.push({
        rule: RULE.IdentifierTooLong,
        file: relFile(trigger.statement),
        message: `trigger identifier "${trigger.name}" exceeds 63 bytes — ADR-0011`,
      });
    }
  }
  return violations;
}

function checkConstraintNaming(tree: ParsedTree): Violation[] {
  const violations: Violation[] = [];
  for (const table of tree.tables) {
    for (const constraint of table.constraints) {
      if (constraint.name === undefined) {
        violations.push({
          rule: RULE.ConstraintUnnamed,
          file: relFile(table.statement),
          message: `table "${table.qualifiedName}": unnamed ${constraint.kind} constraint (${constraint.raw}) — ADR-0011 requires an explicit name`,
        });
        continue;
      }
      if (!matchesNamePattern(constraint.kind, constraint.name, table.table)) {
        violations.push({
          rule: RULE.ConstraintNamePattern,
          file: relFile(table.statement),
          message: `table "${table.qualifiedName}": constraint "${constraint.name}" does not match the ADR-0011 ${constraint.kind} pattern`,
        });
      }
    }
  }
  for (const index of tree.indexes) {
    if (index.name === undefined) {
      violations.push({
        rule: RULE.ConstraintUnnamed,
        file: relFile(index.statement),
        message: `unnamed index on "${index.schema}.${index.table}" — ADR-0011 requires an explicit name`,
      });
      continue;
    }
    // ADR-0011: a standalone UNIQUE index is a uniqueness guard and takes `uq_`, exactly like a
    // unique table constraint ("uq_ covers both"); only non-unique indexes take `ix_`.
    const indexKind = index.unique ? 'UNIQUE' : 'INDEX';
    if (!matchesNamePattern(indexKind, index.name, index.table)) {
      violations.push({
        rule: RULE.ConstraintNamePattern,
        file: relFile(index.statement),
        message: `index "${index.name}" on "${index.schema}.${index.table}" does not match the ADR-0011 ${NAME_PREFIX[indexKind]} pattern`,
      });
    }
  }
  for (const trigger of tree.triggers) {
    if (!matchesNamePattern('TRIGGER', trigger.name, trigger.table)) {
      violations.push({
        rule: RULE.ConstraintNamePattern,
        file: relFile(trigger.statement),
        message: `trigger "${trigger.name}" on "${trigger.schema}.${trigger.table}" does not match the ADR-0011 tg_ pattern`,
      });
    }
  }
  return violations;
}

function checkReservedWordsAbbreviationsAndPlurals(tree: ParsedTree): Violation[] {
  const violations: Violation[] = [];
  for (const table of tree.tables) {
    const names: Array<{ label: string; value: string }> = [
      { label: 'table', value: table.table },
      ...table.columns.map((col) => ({ label: 'column', value: col.name })),
    ];
    for (const { label, value } of names) {
      const lower = value.toLowerCase();
      if (RESERVED_WORDS.has(lower)) {
        violations.push({
          rule: RULE.ReservedWord,
          file: relFile(table.statement),
          message: `${label} "${value}" on "${table.qualifiedName}" is a reserved word — ADR-0011`,
        });
      }
      for (const segment of lower.split('_')) {
        if (KEPT_ABBREVIATIONS.has(segment)) {
          continue;
        }
        if (DENIED_ABBREVIATIONS.has(segment)) {
          violations.push({
            rule: RULE.AbbreviationDenied,
            file: relFile(table.statement),
            message: `${label} "${value}" on "${table.qualifiedName}" contains the denied abbreviation "${segment}" — ADR-0011 ("full words ... organization, not org")`,
          });
        }
      }
    }
    if (isPlural(table.table)) {
      violations.push({
        rule: RULE.PluralTableName,
        file: relFile(table.statement),
        message: `table "${table.qualifiedName}" is plural — ADR-0011 requires singular table names`,
      });
    }
  }
  return violations;
}

function checkEntityPrimaryKeyNaming(
  tree: ParsedTree,
  registry: Readonly<Record<string, LifecycleRegistryRow>>,
): Violation[] {
  const violations: Violation[] = [];
  for (const table of tree.tables) {
    // ADR-0011's compliance bullet reads "an entity table whose primary key is not `<table>_id`"
    // (its own word: ENTITY table) — a `projection`-classed table (ADR-0006) is definitionally
    // not the entity: it is a rebuildable read model that MIRRORS a foreign aggregate's key by
    // design (ADR-0014's rating-aggregation projection is the shape this exemption exists for).
    // Scoping this rule by the registry's own `projection` class, rather than hand-listing table
    // names, applies the same exemption to every future projection table without a gate edit.
    if (registry[table.qualifiedName]?.class === LIFECYCLE_CLASS.Projection) {
      continue;
    }
    // The better-auth library tables keep the library's `id` primary-key column, confined to the
    // auth schema — see LIBRARY_OWNED_PK_TABLES's doc comment.
    if (LIBRARY_OWNED_PK_TABLES.has(table.qualifiedName)) {
      continue;
    }
    const pkConstraints = table.constraints.filter((c) => c.kind === 'PK');
    for (const pk of pkConstraints) {
      if (pk.columns.length !== 1) {
        // Composite natural keys are exempt by design — ADR-0011's stated purpose
        // ("self-describing FK column") is already satisfied by their natural key.
        continue;
      }
      const pkColumn = pk.columns[0];
      if (pkColumn !== `${table.table}_id`) {
        violations.push({
          rule: RULE.EntityPkNotTableId,
          file: relFile(table.statement),
          message: `table "${table.qualifiedName}": single-column primary key "${pkColumn}" is not "${table.table}_id" — ADR-0011`,
        });
      }
    }
  }
  return violations;
}

function checkIfNotExistsAndEnum(tree: ParsedTree): Violation[] {
  const violations: Violation[] = [];
  for (const statement of tree.statements) {
    if (/\bIF\s+NOT\s+EXISTS\b/i.test(statement.sql)) {
      violations.push({
        rule: RULE.IfNotExistsBanned,
        file: relFile(statement),
        message: `"IF NOT EXISTS" is banned in migrations — ADR-0011`,
      });
    }
    if (/^CREATE\s+TYPE\s+\S+\s+AS\s+ENUM\b/i.test(statement.sql.trim())) {
      violations.push({
        rule: RULE.EnumTypeBanned,
        file: relFile(statement),
        message: `native "CREATE TYPE ... AS ENUM" is banned — ADR-0011 (reference tables only)`,
      });
    }
  }
  return violations;
}

function checkRootMigrationDiscipline(tree: ParsedTree): Violation[] {
  const violations: Violation[] = [];

  const rootFiles = tree.files.filter((f) => f.isRootMigration);
  if (rootFiles.length > 1) {
    for (const file of rootFiles) {
      violations.push({
        rule: RULE.MultipleRootMigrations,
        file: file.relativePath,
        message: `more than one migration at index 0 (found: ${rootFiles.map((f) => f.relativePath).join(', ')}) — ADR-0011`,
      });
    }
  }

  for (const statement of tree.statements) {
    const isCluster = CLUSTER_STATEMENT_RE.test(statement.sql.trim());
    if (statement.file.isRootMigration) {
      if (!isCluster) {
        violations.push({
          rule: RULE.NonClusterStatementInRootMigration,
          file: relFile(statement),
          message: `index-0 (root) migration contains a non-cluster-level statement — ADR-0011: "everything a live database can be asked to do belongs at 0001+"`,
        });
      }
    } else if (isCluster) {
      violations.push({
        rule: RULE.ClusterStatementInRunnerMigration,
        file: relFile(statement),
        message: `runner migration (index ${statement.file.indexToken}) contains a cluster-level statement — ADR-0011 confines CREATE DATABASE/ALTER SYSTEM/CREATE ROLE to the index-0 root migration`,
      });
    }
  }

  for (const insert of tree.inserts) {
    if (insert.statement.file.isRootMigration) {
      violations.push({
        rule: RULE.InsertInRootMigration,
        file: relFile(insert.statement),
        message: `index-0 (root) migration contains an INSERT / application-state dependency — ADR-0011`,
      });
    }
  }

  return violations;
}

function checkTimestampAndBoolean(tree: ParsedTree): Violation[] {
  const violations: Violation[] = [];
  for (const table of tree.tables) {
    for (const column of table.columns) {
      const typeNorm = column.type.replace(/\s+/g, ' ').trim().toLowerCase();
      if (typeNorm === 'timestamp' || typeNorm === 'timestamp without time zone') {
        violations.push({
          rule: RULE.TimestampWithoutTimezone,
          file: relFile(table.statement),
          message: `column "${column.name}" on "${table.qualifiedName}" is "timestamp" without a time zone — ADR-0011 requires timestamptz`,
        });
      }
      if (typeNorm === 'boolean' && !column.notNull) {
        violations.push({
          rule: RULE.NullableBoolean,
          file: relFile(table.statement),
          message: `column "${column.name}" on "${table.qualifiedName}" is a nullable boolean — ADR-0011 bans nullable booleans`,
        });
      }
    }
  }
  return violations;
}

function checkUpdatedAtTrigger(tree: ParsedTree): Violation[] {
  const violations: Violation[] = [];
  for (const table of tree.tables) {
    // Match `updated_at` EXACTLY, never as a suffix — a per-stage timestamp column named
    // `{stage}_updated_at` is a different convention, maintained unconditionally by the write
    // path rather than by a trigger, and is NOT this rule.
    const hasUpdatedAtColumn = table.columns.some((col) => col.name === 'updated_at');
    if (!hasUpdatedAtColumn) {
      continue;
    }
    const expectedTriggerName = `tg_${table.table}__set_updated_at`;
    const hasMatchingTrigger = table.statement.file.absolutePath
      ? tree.triggers.some(
          (trigger) =>
            trigger.statement.file.absolutePath === table.statement.file.absolutePath &&
            trigger.table === table.table &&
            trigger.name === expectedTriggerName,
        )
      : false;
    if (!hasMatchingTrigger) {
      violations.push({
        rule: RULE.UpdatedAtWithoutTrigger,
        file: relFile(table.statement),
        message: `table "${table.qualifiedName}" declares "updated_at" with no matching "${expectedTriggerName}" trigger in the same migration — ADR-0011`,
      });
    }
  }
  return violations;
}

function checkStorageParameterDefaults(tree: ParsedTree): Violation[] {
  const violations: Violation[] = [];
  for (const table of tree.tables) {
    for (const { key, value } of parseStorageParams(table.tail)) {
      const defaultValue = DEFAULT_STORAGE_PARAMS[key.toLowerCase()];
      if (defaultValue !== undefined && value.toLowerCase() === defaultValue) {
        violations.push({
          rule: RULE.StorageParameterDefault,
          file: relFile(table.statement),
          message: `table "${table.qualifiedName}" restates storage parameter "${key} = ${value}", which is PostgreSQL's engine default — ADR-0011`,
        });
      }
    }
  }
  return violations;
}

/**
 * ADR-0011, second clause: "Vocabularies used by one module live in that module's schema;
 * vocabularies used by more than one live in `reference`." Every vocabulary in this repo so far
 * happens to be cross-module and therefore lives in `reference`, so this rule has never yet
 * needed to accept a module-local vocabulary — but it is detected STRUCTURALLY rather than
 * through a per-table allowlist, so a future module-local vocabulary is covered the moment it
 * exists: the insert's target must have been `CREATE TABLE`'d, in this same tree, with exactly
 * the ADR's own two-column shape (`<table>_id integer NOT NULL` primary key, `name text NOT NULL`
 * with a UNIQUE constraint on `name` alone) — the same shape every `reference.*` vocabulary
 * already has, just schema-scoped to its one owning module instead of the shared `reference`
 * schema.
 */
function isModuleLocalVocabularyTable(tree: ParsedTree, schema: string, table: string): boolean {
  const created = tree.tables.find((t) => t.schema === schema && t.table === table);
  if (created === undefined) {
    return false;
  }
  const idColumnName = `${table}_id`;
  const idColumn = created.columns.find((c) => c.name === idColumnName);
  const nameColumn = created.columns.find((c) => c.name === 'name');
  if (created.columns.length !== 2 || idColumn === undefined || nameColumn === undefined) {
    return false;
  }
  if (idColumn.type.toLowerCase() !== 'integer' || !idColumn.notNull) {
    return false;
  }
  if (nameColumn.type.toLowerCase() !== 'text' || !nameColumn.notNull) {
    return false;
  }
  const hasIdPrimaryKey = created.constraints.some(
    (c) => c.kind === 'PK' && c.columns.length === 1 && c.columns[0] === idColumnName,
  );
  const hasNameUnique = created.constraints.some(
    (c) => c.kind === 'UNIQUE' && c.columns.length === 1 && c.columns[0] === 'name',
  );
  return hasIdPrimaryKey && hasNameUnique;
}

function checkInsertPlacement(tree: ParsedTree): Violation[] {
  const violations: Violation[] = [];
  for (const insert of tree.inserts) {
    if (insert.statement.file.isRootMigration) {
      // Already reported by checkRootMigrationDiscipline — avoid double-flagging the same INSERT.
      continue;
    }
    if (
      insert.schema !== 'reference' &&
      !isModuleLocalVocabularyTable(tree, insert.schema ?? '', insert.table)
    ) {
      violations.push({
        rule: RULE.InsertIntoNonReferenceTable,
        file: relFile(insert.statement),
        message: `INSERT into "${insert.schema ?? '(unqualified)'}.${insert.table}", which is not a declared reference table and does not match ADR-0011's module-local vocabulary shape (<table>_id integer PK, name text UNIQUE) — reference-row seeding is the only data permitted in a migration`,
      });
    }
  }
  return violations;
}

// --- ADR-0006 lifecycle-registry extension ---------------------------------------------------

export function checkLifecycleRegistry(
  tree: ParsedTree,
  registry: Readonly<Record<string, LifecycleRegistryRow>>,
): Violation[] {
  const violations: Violation[] = [];
  const createdTables = new Set<string>();

  for (const table of tree.tables) {
    const key = table.qualifiedName;
    createdTables.add(key);
    const row = registry[key];
    if (row === undefined) {
      violations.push({
        rule: RULE.LifecycleRegistryMissingRow,
        file: relFile(table.statement),
        message: `"${key}" has no row in tools/arch-checks/src/data-lifecycle-registry.cjs — ADR-0006 requires a lifecycle class for every CREATE TABLE`,
      });
      continue;
    }
    if (
      row.class === LIFECYCLE_CLASS.Evidence &&
      (row.horizon === undefined || row.horizon.trim() === '')
    ) {
      violations.push({
        rule: RULE.LifecycleRegistryEvidenceNoHorizon,
        file: relFile(table.statement),
        message: `"${key}" is registered as "evidence" with no purge horizon — ADR-0006`,
      });
    }
  }

  for (const key of Object.keys(registry)) {
    if (!createdTables.has(key)) {
      violations.push({
        rule: RULE.LifecycleRegistryStaleEntry,
        file: 'tools/arch-checks/src/data-lifecycle-registry.cjs',
        message: `registry row "${key}" names a schema.table that no migration in the scanned tree creates — ADR-0006's inverse-direction check`,
      });
    }
  }

  return violations;
}

// -------------------------------------------------------------------------------------------
// Public entry point
// -------------------------------------------------------------------------------------------

/** Runs every ADR-0011/ADR-0006 static rule against every migration under `repoRoot`. Exported so
 * the fixture self-test and the real-CLI entrypoint below share identical logic against different
 * directories. `registry` defaults to the real `data-lifecycle-registry.cjs`; the fixture
 * self-test overrides it with a synthetic map for the two rules that are properties of the
 * REGISTRY FILE rather than of any one migration (`lifecycle-registry-evidence-no-horizon`,
 * `lifecycle-registry-stale-entry`) — the check takes its registry as data rather than mutating
 * the real, production registry file to exercise them. */
export function checkMigrationDdl(
  repoRoot: string,
  registry: Readonly<Record<string, LifecycleRegistryRow>> = REGISTRY,
): Violation[] {
  const tree = parseAll(repoRoot);
  return [
    ...checkIdentifierLength(tree),
    ...checkConstraintNaming(tree),
    ...checkReservedWordsAbbreviationsAndPlurals(tree),
    ...checkEntityPrimaryKeyNaming(tree, registry),
    ...checkIfNotExistsAndEnum(tree),
    ...checkRootMigrationDiscipline(tree),
    ...checkTimestampAndBoolean(tree),
    ...checkUpdatedAtTrigger(tree),
    ...checkStorageParameterDefaults(tree),
    ...checkInsertPlacement(tree),
    ...checkLifecycleRegistry(tree, registry),
  ];
}

function reportViolations(violations: readonly Violation[]): void {
  console.error('migration-ddl: violations found:');
  for (const violation of violations) {
    console.error(`  [${violation.rule}] ${violation.file} — ${violation.message}`);
  }
}

function main(): number {
  const [, , repoRootArg] = process.argv;
  const repoRoot = repoRootArg !== undefined ? path.resolve(repoRootArg) : REPO_ROOT;

  const violations = checkMigrationDdl(repoRoot);
  if (violations.length === 0) {
    console.log('migration-ddl: no violations found.');
    return 0;
  }

  reportViolations(violations);
  return 1;
}

// Guarded so the fixture self-test can `import` `checkMigrationDdl` without also triggering a
// real-repo CLI run as a side effect (mirrors gate-integrity.ts).
if (import.meta.main) {
  process.exit(main());
}
