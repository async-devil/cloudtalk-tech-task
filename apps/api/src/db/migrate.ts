/**
 * The `moon run api:migrate` entry point: a thin CLI wrapper that composes the persistence config
 * slice (`@repo/config`, ADR-0005) and invokes `runMigrations` on the owner connection
 * (ADR-0006). Boot never auto-migrates; this script is what CI/compose run explicitly. Side
 * effects at import time are confined to entry points like this one.
 */

import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  APP_MODE,
  ConfigError,
  type ConfigSource,
  composeConfig,
  envFileSource,
  processEnvSource,
  readAppMode,
} from '@repo/config';
import {
  type PersistenceSliceConfig,
  configSlice as persistenceConfigSlice,
  runMigrations,
} from '@repo/persistence';

/** The composed shape for the one slice this script needs, assembled from the slice's exported
 * parsed-output type — no field list restated by hand. */
interface MigrateConfig {
  readonly persistence: PersistenceSliceConfig;
}

// `runMigrations` merges every listed folder into one GLOBAL lexicographic order on file name
// (ADR-0011). All migrations live in the single `packages/persistence/migrations/` folder — the
// database-owning module. Resolved monorepo-relative: apps are composition roots, not liftable
// modules, so knowing the workspace layout here is deliberate.
const MIGRATION_FOLDERS = [
  fileURLToPath(new URL('../../../../packages/persistence/migrations', import.meta.url)),
];

async function main(): Promise<void> {
  const mode = readAppMode(process.env);
  // Precedence (later source wins): env-file (test only) -> process env, always last.
  const sources: ConfigSource[] = [
    ...(mode === APP_MODE.Test ? [envFileSource('.env')] : []),
    processEnvSource(process.env),
  ];

  const { config } = await composeConfig<MigrateConfig>({
    mode,
    slices: [persistenceConfigSlice],
    sources,
  });

  const report = await runMigrations({
    ownerConnectionString: config.persistence.DATABASE_OWNER_URL,
    migrationFolders: MIGRATION_FOLDERS,
  });

  for (const name of report.applied) {
    process.stdout.write(`migrate: applied ${name}\n`);
  }
  if (report.error !== undefined) {
    process.stderr.write(
      `migrate: failed at "${report.error.migration}": ${String(report.error.cause)}\n`,
    );
    process.exit(1);
  }
  if (report.applied.length === 0) {
    process.stdout.write('migrate: nothing to apply\n');
  }
}

main().catch((error: unknown) => {
  // Fail-closed config report, applied to this entry point: every issue, key names only, to
  // stderr — then a non-zero exit.
  if (error instanceof ConfigError) {
    for (const issue of error.issues) {
      process.stderr.write(`migrate: config: ${issue.key}: ${issue.message}\n`);
    }
  } else {
    process.stderr.write(`migrate: ${String(error)}\n`);
  }
  process.exit(1);
});
