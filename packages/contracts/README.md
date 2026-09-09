# contracts

## Purpose

The typed-port/wire-contract home (ADR-0001): cross-module ports live here, never as
sibling-internal reaches. Contract-first law applies once a symbol ships (ADR-0004) — these
exports are the boundary between `apps/api` and the SPA (`apps/app`): neither restates the
other's routes, the objects exported here ARE the contract. This package currently ships the
uniform error shape, the session bootstrap contract, and the two mail ports the auth module
consumes; a new HTTP route or bus event adds its own contract/schema file here.

**When NOT to use this.** A type or port belongs here only once a second module actually needs to
see it. A shape two functions inside the SAME module share is not a contract — it stays local to
that module until a real cross-module boundary needs it, or this package becomes a dumping ground
for every interface someone thought might travel someday.

## Public contract

- `appContract` / `emptyContract` — the composed oRPC router `apps/api` mounts and `apps/app`'s
  client is typed from, and a placeholder empty router for a composition root with no route to
  mount yet.
- `apiErrorShape` / `ApiErrorShape` — the uniform `{ code, message, details? }` wire error
  (ADR-0008 defines the codes, ADR-0004 the boundary that renders them).
- `sessionContract` / `sessionBootstrapSchema` / `SessionBootstrap` — the SPA's session bootstrap
  route and payload.
- `MailRendererPort`, `MailSenderPort`, and their supporting types (`MAIL_TEMPLATE`,
  `MailTemplateData`, `RenderedMailBody`, `MailMessage`) — the two ports the auth module depends
  on for turning a magic-link/welcome event into a sent email, without depending on a rendering
  framework or a mail provider SDK.

## Dependencies

`@orpc/contract`, `zod`, workspace `@repo/kernel`.

## Config slice

None — this package has no runtime configuration of its own; it is types and schemas only.

## Named invariants

<!-- Every invariant maps to a test id (ADR-0005); docs-check enforces. -->

- **INV-1** — `apiErrorShape` is the only wire error shape the HTTP boundary (`apps/api`) emits.
- **INV-2** — `MailRendererPort#render` and `MailSenderPort#send` are the only two seams through
  which the auth module produces and delivers email; both are exercised end to end by the auth
  module's `test-integration` suite (this package ships the port types only, with no runtime
  behavior of its own to unit-test).

## Telemetry

None emitted directly — this package has no runtime code path. Any span or metric tied to a
contract defined here (e.g. the `/session/bootstrap` route) is emitted by the app that implements
the route, per ADR-0004.

## Extraction steps

Tier-facade, liftable: depends only on `@orpc/contract`, `zod`, and `@repo/kernel`. No runtime
adapters, no framework imports — safe to consume from both the api app and the browser SPA.
