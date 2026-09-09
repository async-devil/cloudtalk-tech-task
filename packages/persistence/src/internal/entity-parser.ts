import type { ZodType } from 'zod';
import { rowAs, rowsAs } from '../rows.js';

/**
 * A per-entity binding of a domain schema to the raw-row parse boundary (ADR-0004). Persistence
 * is the sole module allowed to know both the entity shape (`@repo/entities`) and the raw-row parse
 * mechanics (`rowAs`/`rowsAs`) — app route/service code sees only the typed result. `T` is inferred
 * from the schema, so there is no separate type to keep in sync.
 */
export interface EntityParser<T> {
  parseRow(row: unknown): T;
  parseRows(rows: unknown[]): T[];
}

/** Builds an {@link EntityParser} from a domain entity schema. One factory call per entity —
 * cheaper and less repetitive than a hand-written `parseXRow`/`parseXRows` pair per domain. */
export function createEntityParser<T>(schema: ZodType<T>): EntityParser<T> {
  return {
    parseRow: (row) => rowAs(schema, row),
    parseRows: (rows) => rowsAs(schema, rows),
  };
}
