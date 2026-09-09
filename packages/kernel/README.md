# kernel

## Purpose

Tier 0 of the modular monolith (ADR-0001): the shared error taxonomy (ADR-0008) and the shared
pure types every other package builds on. Zero workspace dependencies, zero npm dependencies —
this package must be liftable on its own (ADR-0001's autonomy contract).

**When NOT to use this:** the error code set is closed by design. A module-specific failure mode
should map onto one of the nine existing subclasses (optionally with its own `details` shape); it
should not grow this list, and it should never be expressed as a plain `Error` subclass that
bypasses `AppError`. If a genuinely new HTTP-status-shaped failure category is needed, that is a
taxonomy change reviewed against ADR-0008, not a local addition.

## Public contract

Two export groups from the barrel (`src/index.ts`):

- **Errors** (`src/errors/`): `AppError` (abstract base), `AppErrorOptions`, `ErrorCode`,
  `isAppError`, and the nine fixed subclasses `ValidationError`, `UnauthorizedError`,
  `ForbiddenError`, `NotFoundError`, `ConflictError`, `RateLimitedError`, `ProviderError`,
  `ProviderUnavailableError`, `InternalError` (`ProviderError`/`InternalError` also export
  `RetryableErrorOptions`); `describeError` (the never-empty description chain); `classifyRetry`,
  `RETRY_DECISION`, `RetryDecision`, `RetryClassification`, `RETRYABLE_NETWORK_CODES` (the
  type-first / status-code / network-code retry classifier).
- **Types** (`src/types/`): `JsonPrimitive`, `JsonValue`, `JsonObject`, `Brand<T, B>`.

`src/internal/app-error-shape.ts` (the brand + duck-typed shape check shared by `AppError` and
`isAppError`) is never exported from the barrel — it is an implementation seam, not part of the
contract.

## Dependencies

None. No `dependencies` field in `package.json`; no workspace imports.

## Config slice

None — kernel has no runtime configuration.

## Named invariants

<!-- Every invariant maps to a test id (ADR-0005); docs-check enforces. -->

- **INV-1**: every `AppError` subclass fixes its `code`/`httpStatus`/`retryable` at the
  definition site (never at the call site) and is detected by `isAppError`.
  Test: `test/error-taxonomy.test.ts`.
- **INV-2**: `ProviderError` and `InternalError` accept `{ retryable?: boolean }` (default
  `false`, i.e. terminal); no other subclass exposes a `retryable` constructor option — enforced
  structurally by each subclass's constructor signature (`tsc --noEmit` proves it) and pinned at
  runtime for the two exceptions. Test: `test/error-taxonomy.test.ts`.
- **INV-3**: `AppErrorOptions.details`/`.cause` propagate onto the instance (ES2022 `cause`
  chaining); `details` is omitted (not present-as-`undefined`) when not supplied.
  Test: `test/error-taxonomy.test.ts`.
- **INV-4**: `isAppError` recognizes an `AppError`-shaped value (brand `'AppError'` + fixed
  fields) even when it is **not** `instanceof` the package's own `AppError` — the case of a
  duplicated/copied kernel elsewhere in the dependency graph — and rejects lookalikes missing the
  brand or with wrong field types. Test: `test/is-app-error-cross-copy.test.ts`.
- **INV-5**: `ProviderUnavailableError` fixes `code = 'PROVIDER'`, `httpStatus = 503`,
  `retryable = true` always — the constructor accepts no `retryable` override (the wire vocabulary
  does not grow: a 5xx consumer cares that the provider failed, not which transiency subclass).
  Test: `test/error-taxonomy.test.ts`.
- **INV-6**: `describeError` is total — it never returns `''` — and follows the frozen fallback
  chain message -> non-default name -> cause (depth-capped at 3) -> string -> sentinel.
  Test: `test/describe-error.test.ts` (table-driven).
- **INV-7**: `classifyRetry` reads only structured fields (`isAppError`/`retryable`, numeric HTTP
  status, `code` strings) — never `name`/`message` matching, including for foreign errors — and
  rule 7's unknown-default-retry is the explicit ADR-0003 fallback (retry, bounded by the
  transport's own attempts ceiling).
  Test: `test/retry-classifier.test.ts` (one row per rule in the frozen table).

## Telemetry

None. Kernel is pure logic — no spans, no metrics, no log lines. Any observability tied to an
`AppError` (e.g. logging a terminal classification) is emitted by the boundary that catches it,
per ADR-0008.

## Extraction steps

Tier-kernel, liftable: zero dependencies of any kind, so copying `packages/kernel/` to another
repository and running `bun install` there is the entire extraction — nothing to rewire.
