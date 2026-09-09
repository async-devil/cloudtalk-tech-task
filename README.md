# Product reviews

A product-review system — catalogue, reviews, ratings — built as a modular monolith in TypeScript
on Bun, Elysia, Postgres and React.

This repository answers [the assignment brief](docs/assignment.md). The brief asks for the thought
process and the trade-offs behind the implementation; those live in [`docs/adr/`](docs/adr/), one
record per decision, each with the alternatives that were rejected and why. This file is the map.

## Run it

You need Docker and [Bun](https://bun.sh). Nothing else, and no secrets.

```bash
bun install
docker compose -f deploy/compose/dev.yml up -d
bun moon run api:migrate
bun moon run api:dev
```

The API comes up on `http://localhost:3000` in `test` mode — real Postgres and Redis, stubs for
everything that would otherwise need a credential. `bun moon run app:dev` starts the SPA on
`http://localhost:5173`. Sign-in is a magic link; in `test` mode the link is printed to the API's
log rather than emailed, so you can complete the flow with no mail provider.

Grafana, with traces and metrics already flowing, is on `http://localhost:3001`.

## How it is put together

```
apps/api     Bun + Elysia. The HTTP edge, the composition root, health probes.
apps/app     React 19 + Vite + TanStack Router/Query. Feature slices over a shared kernel.
packages/    Ten modules, each a bounded context (see the table below).
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

Modules talk through typed ports or events, never through each other's internals, and the rule is
machine-enforced rather than aspirational — see below.

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
