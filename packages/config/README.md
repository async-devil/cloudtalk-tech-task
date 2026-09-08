# config

## Purpose

Fail-closed, schema-validated configuration (ADR-0005): `APP_MODE` reading, per-module Zod
config slices, layered sources (env-file, process-env), the single composition/parse/freeze step
every app boots through, and the `.env.example` generator.

**When NOT to use this**: this package does not read `process.env` or a `.env` file itself outside
the `ConfigSource` implementations it exports — a composition root passes those sources in
explicitly. It is not a place to add a new secret-fetching source casually: a new `ConfigSource`
implementation is a reviewed addition to the layering (see Named invariants), not a convenience
wrapper around a third-party client.

## Public contract

- `AppMode`, `readAppMode(env)` — the one sanctioned mode switch (ADR-0005).
- `isFailClosed(mode)` — the fail-closed predicate (`staging`/`production`) every config slice and
  the observability SDK key their strictness off.
- `ConfigSlice<S>`, `defineConfigSlice(key, schema)` — a module's mode-aware Zod slice.
- `ConfigSource`, `envFileSource(path)`, `processEnvSource(env)` — layered raw-value sources.
- `ComposedConfig<T>`, `ConfigError`, `composeConfig(options)` — merge → empty-string⇒undefined →
  single parse → deep-freeze → `{ config, report }`.
- `renderEnvExample(slices, documentationSections?)` — renders the canonical `.env.example` from
  composed slice schemas' `.describe()` annotations.

## Dependencies

- `zod` — schema definitions and parsing, incl. `z.toJSONSchema` (`renderEnvExample`'s
  introspection mechanism).
- `@repo/kernel` — `InternalError` for the one programmer-error case (`composeConfig` called with
  duplicate slice keys); `ConfigError` itself intentionally extends `Error` directly, not
  `AppError` (see `src/config-error.ts` for why: it aborts boot before any boundary that handles
  `AppError` exists).

## Config slice

Not applicable — this package defines the slice *mechanism*; it owns no slice of its own. Each
module (`persistence`, `messaging`, `observability`, …) declares its own slice, composed together
by the owning app's composition root.

## Named invariants

- **INV-1**: `readAppMode` accepts only `'test' | 'staging' | 'production'` (ADR-0005); a missing
  or unrecognized `APP_MODE` throws `ConfigError` — no default, no `NODE_ENV` inference.
  Test: `test/mode.test.ts`.
- **INV-2**: `composeConfig` merges sources with later-source-wins precedence, then turns
  empty-string values into "absent" *before* parsing (so a required field reports missing, not
  invalid-type). Test: `test/compose.test.ts`.
- **INV-3**: a failed `composeConfig` throws `ConfigError` whose `issues` list **every** failing
  env key across **every** slice (fail-closed, complete report), keyed by the env var name (not
  the internal slice key). Test: `test/compose.test.ts`.
- **INV-4**: slice schemas are mode-aware — a key required only in a fail-closed tier
  (`isFailClosed(mode)`, i.e. staging/production) may be absent in `test`. Test:
  `test/compose.test.ts`.
- **INV-5**: `composeConfig`'s `report` names every key consumed by any slice and which source won
  (or `'default'` when no source provided it and the schema default applied) — and never contains
  a value. Test: `test/compose.test.ts`.
- **INV-6**: `composeConfig` rejects with `InternalError` (kernel) on duplicate slice keys, before
  resolving any source. Test: `test/compose.test.ts`.
- **INV-7**: the successful `config` object is deep-frozen. Test: `test/compose.test.ts`.
- **INV-8**: `envFileSource` hand-parses dotenv format (`KEY=VALUE`, whole-line `#` comments,
  optional matching single/double quotes stripped verbatim, no `${...}` interpolation); a missing
  file yields an empty map, not an error. Tests: `test/dotenv.test.ts`, `test/sources.test.ts`.
- **INV-9**: source precedence is later-wins by construction order, not by source identity:
  `.env` loads only in `test` mode (a composition root never wires it into a fail-closed tier), and
  process env — placed last by every composition root — wins over it whenever both supply the same
  key. Test: `test/env-precedence.test.ts`.
- **INV-10**: `renderEnvExample` is deterministic (byte-stable across runs on the same slices) and
  classifies each key from its `test`-mode schema alone: required-with-no-default ⇒ uncommented
  empty line; has-a-default ⇒ commented line showing the default; optional-with-no-default ⇒
  commented empty line. `APP_MODE` is a fixed preamble, not part of any slice. Test:
  `test/render-env-example.test.ts`.

## Telemetry

None. This package is a boot-time mechanism, resolved before `initObservability` runs — it has no
module-owned spans, instruments, or log lines of its own to declare. `ConfigError` is thrown, not
logged, so its caller (the composition root) decides how a validation failure is surfaced.
