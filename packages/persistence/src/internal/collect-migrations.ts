import { readdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { InternalError } from '@repo/kernel';
import type { Migration } from 'kysely/migration';

/** Migration files are named `NNNN-imperative-description.(ts|js)` (ADR-0003's exact form),
 * scoped per folder. */
const MIGRATION_FILE_RE = /^\d{4}-.+\.(?:ts|js)$/;
const MIGRATION_EXTENSION_RE = /\.(?:ts|js)$/;

/** One discovered migration file, before its module is loaded. */
export interface MigrationFile {
  /** Migration name = file name without extension; the Migrator's ordering key. */
  readonly name: string;
  readonly folder: string;
  readonly filePath: string;
}

/**
 * Discovers migration files across per-module folders and merges them into one globally,
 * lexicographically ordered list. A duplicate file name across folders is an error —
 * it forces the module prefix into the description and keeps ordering reviewable. Non-matching
 * file names are ignored (folders may hold fixtures/notes; only `NNNN-*.ts|js` are migrations).
 * @throws InternalError naming the duplicate file and both folders.
 */
export async function listMigrationFiles(folders: ReadonlyArray<string>): Promise<MigrationFile[]> {
  const byName = new Map<string, MigrationFile>();

  for (const folder of folders) {
    const entries = await readdir(folder);
    for (const fileName of entries) {
      if (!MIGRATION_FILE_RE.test(fileName)) {
        continue;
      }
      const name = fileName.replace(MIGRATION_EXTENSION_RE, '');
      const existing = byName.get(name);
      if (existing !== undefined) {
        throw new InternalError(
          `duplicate migration file name "${fileName}" found in both "${existing.folder}" and "${folder}" — migration file names must be unique across all folders`,
          { details: { fileName, folders: [existing.folder, folder] } },
        );
      }
      byName.set(name, { name, folder, filePath: `${folder}/${fileName}` });
    }
  }

  // Codepoint (lexicographic) order on the migration name, global across folders. Kysely's
  // Migrator re-sorts by name itself; sorting here keeps the merged view deterministic for
  // callers and tests regardless of readdir order.
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * Loads the discovered migration files into the `Record<name, Migration>` shape Kysely's
 * `MigrationProvider` contract expects, preserving the merged global order.
 * @throws InternalError when a migration module does not export an `up` function.
 */
export async function collectMigrations(
  folders: ReadonlyArray<string>,
): Promise<Record<string, Migration>> {
  const files = await listMigrationFiles(folders);
  const migrations: Record<string, Migration> = {};
  for (const file of files) {
    const module: unknown = await import(pathToFileURL(file.filePath).href);
    migrations[file.name] = migrationFrom(module, file);
  }
  return migrations;
}

function migrationFrom(module: unknown, file: MigrationFile): Migration {
  if (
    typeof module !== 'object' ||
    module === null ||
    typeof (module as { up?: unknown }).up !== 'function'
  ) {
    throw new InternalError(
      `migration file "${file.filePath}" does not export an \`up\` function`,
      { details: { filePath: file.filePath } },
    );
  }
  const shaped = module as { up: Migration['up']; down?: Migration['down'] };
  return shaped.down === undefined ? { up: shaped.up } : { up: shaped.up, down: shaped.down };
}
