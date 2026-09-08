/**
 * Minimal hand-written ambient declarations for the Node/driver surface this package uses,
 * following the declare-only-what-you-use pattern of `packages/config/src/ambient.d.ts` and
 * `tools/arch-checks/src/ambient.d.ts` (no `@types/node` — no registry entry).
 *
 * `pg` ships no bundled types; the community types live in `@types/pg`, which this repository
 * does not depend on. This package only ever hands the pool to Kysely's `PostgresDialect`, so
 * the declaration below types `Pool` directly against Kysely's own structural `PostgresPool`
 * contract — strictly the surface we rely on, checked by `tsc` against the dialect that
 * consumes it.
 */

declare module 'pg' {
  import type { PostgresPool } from 'kysely';

  /** The subset of `pg.PoolConfig` this package sets (node-postgres.com/apis/pool). */
  export interface PoolConfig {
    connectionString?: string;
    max?: number;
    application_name?: string;
  }

  export const Pool: new (config?: PoolConfig) => PostgresPool;
}

declare module 'node:fs/promises' {
  export function readdir(path: string): Promise<string[]>;
}

declare module 'node:url' {
  export function pathToFileURL(path: string): { readonly href: string };
}
