# @repo/api

The backend deployable: the Elysia HTTP edge, the oRPC contract implementation, the composition
root that names every concrete adapter, and the health probes a deploy gate polls.

**When NOT to put something here.** This app is a composition root, not a place for domain logic
(ADR-0005). A rule about reviews belongs in the module that owns reviews; what belongs here is the
wiring that decides which implementation of a port that module receives, and the transport concerns
around it — headers, CORS, the body cap, rate limits, error mapping.

## What it serves

| Path | What it is |
|---|---|
| `/api/*` | The mounted oRPC handler implementing `appContract`. Session-required. |
| `/api/auth/*` | better-auth's own fetch handler, mounted from `@repo/auth`. |
| `/health` | Process liveness plus a bounded Postgres round trip. |
| `/health/worker` | Registered only when this root starts background workers. |

## Composition root

`src/runtime/main.ts` is the one file that names concrete adapters. Everything else receives ports.
`APP_MODE` decides which: `test` wires deterministic stubs and lenient config; `staging` and
`production` wire real adapters and refuse to boot on a missing required key, listing every missing
key at once rather than failing on the first.

Two adapters live here because the modules that need them must not know about them:

- `src/runtime/mail-renderer.ts` — a plain-text magic-link renderer.
- `src/runtime/mail-sender.ts` — a development sender that logs the link through the observability
  facade. It **refuses to construct in a fail-closed tier**, which is what keeps a stub out of
  production. ADR-0013 records this as a deliberate limitation: there is no production mail
  transport in this repository yet.

## Config slice

`src/config/api-slice.ts`, composed with every module's slice. `.env.example` at the repository
root is generated from the composed schema (`moon run api:env-example -- --write`) and checked in
CI, so a key that exists in code and not in the example is a red build.

## Named invariants

- **INV-1** — A namespace declared in `appContract` and not implemented is a compile error, not a
  404 found in production (→ `test/build-app.test.ts`).
- **INV-2** — Every contract route is session-required; with no session wiring at all the app fails
  closed rather than open (→ `test/build-app.test.ts`).
- **INV-3** — Only public tokens cross the wire; an internal uuid never appears in a response
  (→ `test/session-router.test.ts`).
- **INV-4** — Domain failures become status codes in the error mapper only; no handler builds its
  own error `Response` (→ `test/error-mapper.test.ts`).
- **INV-5** — The metric `route` attribute is a bounded enum derived from the contract, so a
  per-request path can never reach a label (→ `test/route-template.test.ts`).
- **INV-6** — A rate-limit bucket that names a route the contract does not declare fails at boot
  rather than silently limiting nothing (→ `test/route-template.test.ts`).
- **INV-7** — The e2e session-mock route is registered only in `test` mode AND only when its
  wiring is supplied; a production build has no such path (→ `test/test-session-route.test.ts`).
- **INV-8** — Health routes are never RED-metered: a five-second-polled probe would otherwise mint
  a route series for nothing (→ `test/health-routes.test.ts`).
- **INV-9** — A permanently worker-dead process exits rather than serving while silently doing no
  background work (→ `test/worker-liveness.test.ts`).

## Telemetry

Source records: [ADR-0009](../../docs/adr/ADR-0009-observability-through-a-facade.md) and
[ADR-0004](../../docs/adr/ADR-0004-elysia-edge-and-orpc-contracts.md).

This app emits no spans of its own — the request span comes from the Elysia OpenTelemetry
integration, and the modules it composes emit their own.

| instrument | kind | attributes | values / semantics |
|---|---|---|---|
| `api.http.request` | histogram (ms) | Route, Method, StatusClass | the RED histogram; Route is always the contract TEMPLATE, never a concrete path |
| `api.http.error` | counter | Route, Method, StatusClass | one tick per non-2xx, sharing `api.http.request`'s dimension set by construction |
| `api.http.body-rejected` | counter | Route | one tick per request refused by the body cap |
| `api.http.rate-limited` | counter | Queue | one tick per 429; Queue is the bucket |
| `api.http.rate-limit-degraded` | counter | Queue | one tick per fail-open allow, which is what makes degradation measurable rather than invisible |

## Extraction

Apps are deployables, not liftable modules — the named exception in ADR-0001. There is no
`extract-module` run for this package.
