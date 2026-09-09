# persistence

## Purpose

The Kysely data-access capability (ADR-0006): the pooled connection factory, the
multi-folder migration runner, and the typed raw-row parse boundary. Modules receive `Kysely<DB>`
handles by injection from a composition root — they never import this factory themselves.

**When NOT to use this.** This package owns connecting to Postgres and parsing what comes back —
never what a table means or when a row may be written. A domain rule ("a review needs a rating," "a
session expires after N days") belongs in the module that owns that data, expressed as ordinary
`Kysely` queries against the handle it was given; reaching into `packages/persistence` to add a
domain-shaped helper here would give every other module's schema a reason to depend on this one.

## Public contract

One barrel (`src/index.ts`):

- `createDb<DB>(options: DbOptions): Kysely<DB>` / `destroyDb(db)` — pg `Pool` +
  `PostgresDialect`; pool size defaults to 10.
- `runMigrations(options: MigrateOptions): Promise<MigrationReport>` — merges per-module
  migration folders into one Kysely `Migrator` run on a dedicated owner connection (ADR-0006).
- `rowsAs<T>(schema, rows)` / `rowAs<T>(schema, row)` — the raw-SQL parse boundary
  (ADR-0004/0011): raw rows pass a Zod row schema or throw kernel `InternalError`.
- `configSlice` — the persistence config slice (ADR-0005; keys frozen in).

## Dependencies

`kysely`, `pg`, `zod` (all exact-pinned per
[docs/trusted-code-sources.md](../../docs/trusted-code-sources.md)); workspace: `@repo/kernel`
(errors), `@repo/config` (`defineConfigSlice`). `pg` is typed by a minimal hand-written ambient
declaration against Kysely's structural `PostgresPool` contract (`src/ambient.d.ts`) — no
`@types/pg`.

## Migrations folder

`migrations/` is THE migration folder: one global index sequence for the whole workspace
(ADR-0006), because per-module folders make ordering across modules a matter of luck. Its first
resident is `0001-create-persistence-bootstrap.ts` at global index `0001` — a module's first
migration is numbered by dependency order across the workspace, not by being that module's first.
It creates `CREATE SCHEMA persistence`,
`CREATE SCHEMA reference` (owned by no single module — every context's closed vocabularies are
seeded into it, ADR-0011), and `persistence.set_updated_at()`, the shared `BEFORE UPDATE`
trigger function ADR-0011 mandates for every row-level `updated_at` column. Every migration in the
repository lives in this one folder, applied in global filename
order, so this bootstrap (`0001`) lands ahead of every schema that depends on it — e.g.
`0002-create-jobs-spine.ts` seeds its vocabularies into `reference`.

## Config slice

| env key | required | default (non-live) |
|---|---|---|
| `DATABASE_URL` | always | — |
| `DATABASE_OWNER_URL` | live (migrate task, ADR-0006) | falls back to `DATABASE_URL` |
| `DATABASE_POOL_SIZE` | no | `10` |

## Named invariants

<!-- Every invariant maps to a test id (ADR-0010.4); docs-check enforces. -->

- **INV-1**: `rowsAs` throws kernel `InternalError` naming the offending row index (and safe
  issue paths, never row values) on parse failure; `rowAs` likewise for a single row — the
  raw-SQL edge is a parse boundary, no `as unknown as` on query results anywhere. The
  classification is `InternalError` rather than `ValidationError` on purpose: a row that does not
  match its schema is schema drift on our side, so it must not reach a caller as a 400 carrying
  internal column paths.
  Test: `test/rows.test.ts`.
- **INV-2**: migration folders merge into **one global lexicographic order on file name**,
  independent of the folder-list order; non-`NNNN-imperative-description.(ts|js)` entries are ignored.
  Test: `test/collect-migrations.test.ts`.
- **INV-3**: a duplicate migration **file name across folders is an error** (kernel
  `InternalError` naming the file and both folders) — forces the module prefix into the
  description, keeps global ordering reviewable. Test: `test/collect-migrations.test.ts`.
- **INV-4**: the config slice requires `DATABASE_OWNER_URL` in `live` mode and falls back to
  `DATABASE_URL` otherwise; `DATABASE_POOL_SIZE` coerces from its env string and defaults to 10.
  Test: `test/config-slice.test.ts`.
- **INV-5**: `runMigrations` applies DDL only through a **dedicated single-connection owner
  handle** (never an app pool) under Kysely's built-in migration lock, so concurrent invocations
  are safe. `packages/persistence` ships no `test-integration/` directory, so this invariant has no
  automated proof today — it is verified manually against a scratch Postgres instance.
- **INV-6**: `0001-create-persistence-bootstrap.ts` creates `reference` and
  `persistence.set_updated_at()` exactly once, with no `IF NOT EXISTS` guard (ADR-0011) — a
  second creator anywhere else is a migration failure, not a silent no-op. Proven by
  `packages/jobs`' own Testcontainers suite, which runs this migration ahead of its own
  (the global index ordering).

## Telemetry

None. `packages/persistence` calls no `withSpan`, defines no counter or histogram, and imports no
`@repo/observability` — every query this package runs executes inside whichever span the caller
already opened (e.g. a `jobs` stage's own span wraps the `Kysely` calls it makes through this
package's handle). Adding telemetry here would double-count work its callers already measure.
Source record: [ADR-0009](../../docs/adr/ADR-0009-observability-through-a-facade.md) — the facade
this package has nothing to report through.

## Extraction steps

1. Copy `packages/persistence/` to the target repository.
2. Vendor or re-add its two workspace deps (`@repo/kernel`, `@repo/config` — both liftable,
   kernel has zero deps) and `bun install`.
3. `tsc` build and `vitest run` must pass standalone — `bun run extract-module persistence` runs
   exactly these three steps and is the real proof, not an approximation of it.
