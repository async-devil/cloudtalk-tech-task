// Public barrel — the module's entire public contract (ADR-0002: one barrel, no nested barrels).
export { configSlice, type PersistenceSliceConfig } from './config-slice.js';
export { createDb, type DbOptions, destroyDb } from './db.js';
export type { EntityParser } from './internal/entity-parser.js';
export { type MigrateOptions, type MigrationReport, runMigrations } from './migrate.js';
export { rowAs, rowsAs } from './rows.js';
