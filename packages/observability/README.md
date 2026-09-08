# observability

## Purpose

The observability facade (`tier-facade`, liftable): the only surface product modules may use to
emit telemetry. It owns three conventions the whole repository depends on — span/instrument
naming, a closed metric-attribute cardinality budget, and the single place an error's telemetry
triple (span status, error metric, structured log) is recorded — so that instrumentation added in
any module correlates with instrumentation added in any other.

**When NOT to use this**: this package is not a place to reach for `@opentelemetry/api` or `pino`
directly — that import is dep-cruiser-blocked outside this package and `./sdk`'s composition-root
callers. It is also not a metrics store or a log viewer; it emits signals, it does not retain or
query them (that is the OTel Collector's job, configured outside this repository's code).

Two entries:

- **`@repo/observability`** — the facade: `createModuleObservability`, `withJobStageSpan`,
  `withBusEventSpan`, propagation helpers, `failSpan`/`FailSpanOptions`/`activeSpan`. Depends on
  `@opentelemetry/api` + pino only — no SDK.
- **`@repo/observability/sdk`** — `initObservability`, the programmatic OTel SDK wiring.
  Importable **only** from a composition root (dep-cruiser rule): the SDK is wired exactly once
  per app, first thing at boot.

Governing decision: ADR-0009 (facade, span naming, cardinality rules). `failSpan`'s error-code and
retry-reason fields are governed by ADR-0008 (typed error taxonomy).

## Public contract

One barrel (`src/index.ts`) plus the `./sdk` subpath — both are the module's entire public
contract; `src/internal/` is never exported.

- `createModuleObservability(moduleName): ModuleObservability` — the per-module facade:
  `withSpan`, `logger`, `createCounter`, `createHistogram`. `moduleName` prefixes and validates
  every span/instrument name and is bound onto every log record and span.
- `withJobStageSpan(options, fn)` / `withBusEventSpan(options, fn)` — the two sanctioned
  exceptions to the module-prefix span-naming rule, reserved for `@repo/messaging`.
- `failSpan(error, options)` / `activeSpan()` — the boundary error-telemetry helper.
- `injectTraceContext()` / `runWithTraceContext(carrier, fn)` — W3C tracecontext carried
  explicitly across queue/bus hops.
- `configSlice` / `ObservabilitySliceConfig` — the observability config slice.
- `initObservability(options): ObservabilityHandle` (from `./sdk`) — wires the OTel SDK + process
  logger once; returns `{ shutdown() }`.

## Dependencies

- `@opentelemetry/api` — the facade's only telemetry surface in the main entry; keeps product
  modules off the SDK.
- `@opentelemetry/sdk-node`, `@opentelemetry/sdk-metrics`,
  `@opentelemetry/exporter-trace-otlp-http`, `@opentelemetry/exporter-metrics-otlp-http`,
  `@opentelemetry/resources` — SDK wiring, used only behind the `./sdk` subpath.
- `pino` / `pino-pretty` — the process logger; `pino(` appears only in this package (lint-enforced
  repo-wide), so every log line goes through one construction site.
- `zod` — the config slice schema.
- `@repo/config` — `defineConfigSlice`, `isFailClosed`, `APP_MODE` for the config slice and the
  SDK's fail-closed endpoint check.
- `@repo/kernel` — `ValidationError` (naming violations), `isAppError`/`ERROR_CODE`/`classifyRetry`
  (the code and retry reason `failSpan` logs), `InternalError` (double-init, unsupported exemplar
  strategy).

## Config slice

| env key | required | default (non-live) |
|---|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` | live | `http://localhost:4318` |
| `OTEL_SERVICE_NAME` | no | `api` |
| `OTEL_SERVICE_NAMESPACE` | no | `reviews` |
| `DEPLOYMENT_ENVIRONMENT` | live | `dev` |
| `LOG_LEVEL` | no | `info` (no `trace` level) |

## Named invariants

- **INV-1**: facade span/instrument names must match `{module}.{object}.{verb}` and start with the
  owning module; violations throw kernel `ValidationError`. Test: `test/naming.test.ts`.
- **INV-2**: the metric attribute budget is structural: out-of-budget attributes throw at spec
  time, undeclared attributes throw at record time. Test: `test/metrics-budget.test.ts`.
- **INV-3**: `withSpan` sets the `module` attribute and INTERNAL kind by default. Test:
  `test/spans.test.ts`.
- **INV-4**: `withSpan` on throw sets span status ERROR, rethrows, and records **no** exception
  event — `recordException` + the error counter + the single log belong to `failSpan`. Test:
  `test/spans.test.ts`.
- **INV-5**: `withJobStageSpan` emits `jobs.{pipeline}.{stage}` (CONSUMER kind), the sanctioned
  exception to the module-prefix rule, used only by `@repo/messaging`'s worker wrapper. Test:
  `test/spans.test.ts`.
- **INV-6**: `injectTraceContext`/`runWithTraceContext` carry W3C tracecontext across explicit
  hops: the consumer span joins the producer's trace as a child. Test: `test/spans.test.ts`.
- **INV-7**: every log emitted inside an active span carries `trace_id`/`span_id`/`trace_flags`
  (pino mixin). Test: `test/logger.test.ts`.
- **INV-8**: module loggers re-bind lazily when `initObservability` replaces the process logger;
  modules constructed pre-init never handle "logger not ready". Test: `test/logger.test.ts`.
- **INV-9**: redaction is central (one list in `src/internal/logger-state.ts`); seeded secrets
  never appear in output; call sites cannot opt out. Test: `test/logger.test.ts`.
- **INV-10**: the SDK is wired exactly once per app: double init throws, a fail-closed tier
  (staging/production) without an OTLP endpoint refuses to boot. Test: `test/sdk-init.test.ts`.
- **INV-11**: the config slice defaults everything in `test` mode and fail-closed-requires
  `OTEL_EXPORTER_OTLP_ENDPOINT` + `DEPLOYMENT_ENVIRONMENT` in staging/production; no `trace` log
  level exists. Test: `test/config-slice.test.ts`.
- **INV-12**: the exemplar-strategy seam: `initObservability` defaults to `collector-spanmetrics`;
  selecting `sdk-native` throws until the SDK supports exemplar export. Test:
  `test/sdk-init.test.ts`.
- **INV-13**: `failSpan` is the ONLY `recordException` call site in the repo (INV-4 stands:
  `withSpan` never records). In order: resolve `options.span ?? activeSpan()` and, if present,
  record the exception + set span status ERROR; tick `errorCounter.add(1, attributes)`; emit
  exactly one `logger.error({ code, reason, cause }, message)` where `code` is `error.code` when
  `isAppError(error)` else `ERROR_CODE.Internal`, and `reason` is `classifyRetry(error).reason`.
  Each step is isolated — a throwing counter/logger cannot stop the remaining steps — and
  `failSpan` itself never throws and never rethrows the input. Test: `test/fail-span.test.ts`.

## Telemetry

This is the module that defines the conventions every other module's telemetry section follows.

**Cardinality budget** — the only attribute keys any instrument in the repository may declare
(`src/metrics.ts`'s `METRIC_ATTRIBUTE`, enforced by `assertSpecification`/`checkAttributes`):

| attribute | values |
|---|---|
| `route` | route templates (`/products/{id}`), never raw URLs |
| `method` | HTTP methods |
| `status_class` | `1xx`…`5xx` |
| `stage` | pipeline stage names |
| `outcome` | bounded outcome enums (`ok`, `error`, …) |
| `queue` | queue/event names |

**Never:** tenant id, user id, entity id, or raw URLs as attribute values — those belong on spans,
where high-cardinality data is expected and searchable. Extending the budget is one reviewed
change: `src/metrics.ts` plus this table.

**Span classes** (three, exhaustively):

- Module-owned: `{module}.{object}.{verb}`, INTERNAL kind by default — every module's own work.
- Job-stage: `jobs.{pipeline}.{stage}`, CONSUMER kind — `@repo/messaging`'s worker wrapper only.
- Bus-event: `event.{eventType}`, CONSUMER kind — `@repo/messaging`'s bus consume path only.

**This package's own spans/instruments**: none — it is the facade other modules call through, and
emits no telemetry of its own beyond what callers construct via `createModuleObservability`.

**Exemplar strategy**: `@opentelemetry/sdk-metrics` 2.4.0 cannot emit metric exemplars on any
runtime — the exemplar classes exist but nothing references them and the exported `MetricData` has
no exemplars field. The metrics→traces link is delivered instead by the live default,
`collector-spanmetrics`: the app records every measurement inside an active span, and the OTel
Collector's spanmetrics connector derives exemplar-bearing RED metrics from those spans directly.
`sdk-native` is the reserved seam in `src/sdk.ts#applyExemplarStrategy` — when a verified SDK
release can export exemplars, the reservoir/filter enablement goes there and the collector
connector retires. No facade call-site changes either way, since the app already records in-span.

**Redaction**: one reviewed list (`src/internal/logger-state.ts`'s `REDACT_PATHS`) covers the
secret-shaped keys (`password`, `token`, `secret`, `apiKey`/`api_key`) and PII (`email`) at the top
level and one nesting level, plus `authorization`/`cookie`/`set-cookie` headers in both common
casings. Deeper nestings are not reachable by pino redaction, so the invariant is never log
free-form deep objects containing credentials — not "redaction will catch it".

**Trace correlation**: every log emitted inside an active span carries `trace_id`, `span_id`, and
`trace_flags` via a pino mixin, so a log line and the span it was emitted from are one click apart
in any backend that indexes both by trace id.
