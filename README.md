# Product reviews

A product-review system — catalogue, reviews, ratings — built as a modular monolith in TypeScript
on Bun, Elysia, Postgres and React.

This repository answers [the assignment brief](docs/assignment.md). The brief asks for the thought
process and the trade-offs behind the implementation; those live in [`docs/adr/`](docs/adr/), one
record per decision, each with the alternatives that were rejected and why. This file is the map;
[ARCHITECTURE.md](ARCHITECTURE.md) is the narrative walk through it, including one review
submission traced end to end.

## Run it

You need Docker and [Bun](https://bun.sh) **1.3.14 or newer** (the version pinned in
[`.moon/toolchains.yml`](.moon/toolchains.yml)) — nothing else, and no secrets. Older Bun lacks
`Bun.RedisClient`, which `@repo/messaging` uses directly; the API fails at startup with `undefined
is not a constructor` on a too-old Bun. Check with `bun --version`; upgrade with `bun upgrade`.

```bash
bun run setup
```

That one command brings up Postgres and Redis, applies the migrations, seeds a realistic
catalogue, starts the API and the SPA, and prints the URL to open. It is idempotent — running it
again does not duplicate seed data. The API comes up in `test` mode — real Postgres and Redis,
stubs for everything that would otherwise need a credential. Sign-in is a magic link; in `test`
mode the link is printed to the API's log rather than emailed, so you can complete the flow with no
mail provider. Two seeded accounts are printed at the end for exercising the capability-gated
screens: a `catalogue_manager` and a `moderator`.

## How it is put together

```
apps/api     Bun + Elysia. The HTTP edge, the composition root, health probes.
apps/app     React 19 + Vite + TanStack Router/Query. Feature slices over a shared kernel.
packages/    Eleven modules, each a bounded context (see the table below).
tools/       The gates that keep the architecture honest, and the extraction proof.
docs/        Decision records, implementation tasks, and the brief being answered.
```

| Module | What it owns |
|---|---|
| `kernel` | The typed error taxonomy and branded types. Zero workspace dependencies. |
| `contracts` | The oRPC contract the API implements and the SPA consumes, plus the port interfaces. |
| `entities` | Reference vocabularies and the public-token minter. |
| `config` | Per-module config slices, composed and fail-closed outside `test`. |
| `observability` | The OpenTelemetry facade: spans, instruments, the logger. |
| `messaging` | BullMQ transport, the best-effort event bus, sliding-window rate limiting. |
| `persistence` | The Kysely factory, the migration runner, typed raw-row parsers. |
| `jobs` | The durability spine: stage helpers, transactional outbox, reconciler, dead-letter queue. |
| `auth` | Magic-link authentication, session resolution, credential retention. |
| `styles` | Design tokens and the vendored primitives built on them. |
| `reviews` | The catalogue and review bounded context: products, reviews, moderation, and the rating projection. |

Modules talk through typed ports or events, never through each other's internals, and the rule is
machine-enforced rather than aspirational — see below.

## Endpoints and user flow

Everything the SPA calls is one contract, [`packages/contracts`](packages/contracts/src/contracts/app-contract.ts)
— the source of truth for request/response shapes; this table is just an index into it. Two
namespaces are anonymous reads, one write needs a session, and two are gated behind a capability
(`catalogue_manager` / `moderator`) enforced server-side regardless of what the session bootstrap
told the client to render (ADR-0018).

| Namespace.procedure | HTTP | Path | Who |
|---|---|---|---|
| `session.bootstrap` | GET | `/session/bootstrap` | any signed-in session |
| `products.list` | GET | `/products` | anonymous |
| `products.get` | GET | `/products/{productSlug}` | anonymous |
| `products.create` | POST | `/products` | `catalogue_manager` |
| `products.update` | PATCH | `/products/{productSlug}` | `catalogue_manager` |
| `reviews.listForProduct` | GET | `/products/{productSlug}/reviews` | anonymous |
| `reviews.submit` | POST | `/products/{productSlug}/reviews` | signed-in session |
| `reviews.update` | PATCH | `/reviews/{reviewToken}` | the review's own author |
| `reviews.remove` | DELETE | `/reviews/{reviewToken}` | the review's own author |
| `reviews.moderationList` | GET | `/moderation/reviews` | `moderator` |
| `reviews.reject` | POST | `/reviews/{reviewToken}/reject` | `moderator` |
| `reviews.restore` | POST | `/reviews/{reviewToken}/restore` | `moderator` |

Sign-in itself is not on this contract: `/api/auth/*` is [better-auth](https://www.better-auth.com/)'s
own handler, mounted separately in [`apps/api/src/runtime/build-app.ts`](apps/api/src/runtime/build-app.ts),
and the magic-link send/verify pair lives there.

**The reviewer journey** (SPEC-0001's journeys, screens `S1`–`S6`): land on the catalogue
(anonymous `products.list`) → open a product (`products.get` + `reviews.listForProduct`, still
anonymous) → sign in with a magic link (`/api/auth/*`, no password) → `session.bootstrap` tells the
router onboarding is done and which affordances to render → submit a review (`reviews.submit`) →
edit or delete only your own (`reviews.update` / `reviews.remove`). A submitted review is visible
immediately in `reviews.listForProduct` (the authoritative table); the product's average rating on
`products.list`/`products.get` reads a separate, eventually-consistent projection that a background
worker recomputes (ADR-0014) — see [ARCHITECTURE.md](ARCHITECTURE.md)'s end-to-end trace of exactly
this submission.

**The catalogue-manager journey** (screen `S7`): everything above, plus `products.create` and
`products.update` for the create/edit product screens — gated by `auth.app_user.catalogue_manager`,
not by the client-side `canManageCatalogue` hint.

**The moderator journey** (screen `S8`): `reviews.moderationList` to see flagged/pending reviews,
`reviews.reject` / `reviews.restore` to act on one — gated by `auth.app_user.moderator`, independent
of the catalogue-manager capability.

## The decisions

Start with these three; the rest of [`docs/adr/`](docs/README.md) fills in around them.

- **[ADR-0001](docs/adr/ADR-0001-modular-monolith-of-bounded-contexts.md)** — why a modular
  monolith, and why module independence is proven by CI rather than asserted. `bun run
  extract-module --all` copies each module out of the repository with only its declared
  dependencies and builds and tests it standing alone. An undeclared import fails the run, which is
  half the tool's value.
- **[ADR-0014](docs/adr/ADR-0014-rating-aggregation-as-a-projection.md)** — the domain decision. A
  product's average rating is a rebuildable projection recomputed off the request path, not
  authoritative state updated in the review's transaction. It argues the hot-row and
  permanently-wrong-aggregate failure modes of the alternatives, and it is the reason the job spine
  in ADR-0007 exists at all.
- **[ADR-0007](docs/adr/ADR-0007-jobs-transport-and-durability-spine.md)** — what "durable
  background work" costs: an outbox, a six-step idempotency shape for every worker, a reconciler
  that treats Postgres as the truth about outstanding work, and a bounded dead-letter path.

## What keeps it honest

Every architectural rule names the check that enforces it. `moon ci` runs the chain:

| Check | What it refuses |
|---|---|
| `depcruise` | A cross-module import that bypasses a barrel, a tier violation, a cycle, a feature slice reaching into another. |
| `extract-module` | A module whose declared dependencies are not the ones it actually uses. |
| `no-core-logging` | A `console` call outside a designated boundary — a log line with no trace context. |
| `telemetry-map` | A span or instrument the module's README does not list, or lists and does not emit. |
| `migration-ddl` | A migration that breaks the naming and append-only conventions. |
| `docs-check` | A decision record that violates the documentation contract, or a stale generated index. |
| `gate-integrity` | A gate that was quietly renamed away or commented out. |

Each gate ships with red fixtures — deliberate violations it must still catch. A gate that has
stopped matching looks exactly like a codebase that has stopped violating it, and the fixtures are
what tell the two apart.

## Known limitations

Stated plainly, because a reviewer will find them anyway:

- **No production mail transport.** The magic-link sender is a development adapter that logs the
  link. A fail-closed tier refuses to boot without a real one. The port, the renderer and the
  per-address rate limit are all in place and tested; wiring a provider is a composition-root
  change. Recorded in [ADR-0013](docs/adr/ADR-0013-authentication-and-security-baseline.md).
- **The rating aggregate is eventually consistent.** A submitted review appears immediately, because
  the review list reads the authoritative table; the average may lag by the time the recompute
  takes. This is the trade [ADR-0014](docs/adr/ADR-0014-rating-aggregation-as-a-projection.md) makes
  deliberately.
- **No multi-tenancy.** A session resolves to a user and nothing else. Adding a tenant dimension
  later is a migration and a change to every scoped query — a deliberate bet, argued in ADR-0013.
- **Client-rendered.** Nothing behind the router is indexable. Fine for an application behind a
  sign-in, a real constraint if a public catalogue later needs SEO.
- **Three modules need build tools to extract.** `messaging`, `jobs` and `auth` carry
  `testcontainers` as a dev dependency, which pulls a transitive native module (`cpu-features`)
  whose install script needs `node-gyp`. Without it `bun run extract-module <one of those>` fails
  at install — not at the boundary the proof is about. The other seven modules extract, build and
  test standing alone on a bare machine.
- **The container suites need Docker.** Without a reachable daemon `moon ci` skips them loudly and
  says so; in CI their absence is a hard failure, because a durability proof that did not run must
  never read as one that passed.

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) covers how to add a module, how to write a decision record, and
what review checks for. The short version: a new capability is a new module wired at a composition
root, never a new folder inside an existing one.
