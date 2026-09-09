# Architecture

The narrative walk. [README.md](README.md) is the map and [`docs/adr/`](docs/README.md) holds the
decisions; this file explains how the pieces move.

## The shape

One deployable system, composed of workspace modules, each a bounded context. Four tiers, and
imports only ever point down them:

```
        apps/api   apps/app          composition roots — no domain logic
              ↓
  persistence  jobs  auth  styles     capability modules
              ↓
 contracts  entities  observability  config  messaging    facades
              ↓
                  kernel                     zero workspace dependencies
```

Two channels connect modules and no others: a **typed port** declared in `@repo/contracts` for
synchronous calls, and an **event** on `@repo/messaging` for asynchronous ones. A module never
imports another module's internals. `dependency-cruiser` checks every import against this on every
run, and `tools/extract-module` checks the stronger claim underneath it — that each module's
declared dependencies really are the ones it uses — by building and testing the module outside the
repository entirely.

The tier ordering is what keeps the graph acyclic. `kernel` depends on nothing, so the error
taxonomy is available everywhere without dragging anything with it; `contracts` depends only on
`kernel` and `entities`, so both sides of the wire can import it.

## The three lifecycles

### A request

```
browser → apps/api (Elysia)
            ├─ security headers, CORS allow-list, body cap, rate limit
            ├─ mounted oRPC handler
            │    ├─ resolveRequestSession  → @repo/auth → auth.app_user
            │    ├─ Zod parse of the input (the boundary: untrusted becomes trusted)
            │    └─ router → the owning bounded context
            └─ error mapper: AppError code → status + wire shape
```

Two things about this path are easy to get wrong and are worth stating. First, Elysia's lifecycle
hooks **do not fire for `.mount()`-ed handlers**, and the oRPC handler is mounted — so session
resolution and response headers cannot be expressed as hooks and are applied inside the handler or
an explicit wrapper. Second, only the route *template* reaches metric attributes, never the
concrete path: a per-entity id in a label set multiplies the series count by the number of entities
(ADR-0009).

Errors are handled exactly once, here at the edge. Nothing below catches, logs and rethrows.

### A job

Anything that must not block a request goes through the durability spine. The shape every worker
follows (ADR-0007):

```
1. state check          already done? return — this is what makes replay a no-op
2. advisory-lock claim  two workers on one row do not both proceed
3. external call        OUTSIDE any transaction, always
4. write ahead          record the outcome before acknowledging it
5. single commit        a crash lands cleanly on one side of it
6. enqueue downstream   through the outbox, in that same transaction
```

The reconciler treats Postgres as the truth about what remains outstanding and re-enqueues what
Redis lost. That is what makes flushing Redis a throughput event rather than a data-loss event —
and there is a container test that flushes it and asserts recovery, because a durability claim that
has never been executed is a claim.

A job that fails permanently stops after a bounded number of attempts and lands in the dead-letter
queue, visible, rather than spinning forever.

### An event

The transactional outbox is the join between the two. A write that must fan out to another process
commits its domain row and its outbox row together, so there is no window where the work happened
and its follow-up was never scheduled. A relay drains the outbox onto messaging; the event bus is
best-effort by design, because anything that must not be lost goes through the outbox, not the bus.

This is exactly the path a review submission takes to its rating aggregate
([ADR-0014](docs/adr/ADR-0014-rating-aggregation-as-a-projection.md)): the review insert and its
outbox row commit together, a worker recomputes that product's aggregate from the authoritative
reviews, and the projection can be dropped and rebuilt at any time because the inputs are still
there.

## Configuration and composition

Every concrete adapter is named in exactly one place per deployable, `apps/*/src/runtime/`. Modules
declare ports and never import a provider SDK; `dependency-cruiser` confines each SDK to the module
that owns it or to a composition root.

`APP_MODE` is the only global switch. `test` wires deterministic stubs and lenient config — it is
what a fresh clone runs, and the whole flow works with zero secrets. `staging` and `production`
wire real adapters and fail closed: a boot with a missing required key refuses to start and lists
every missing key at once, rather than failing on the first one or, worse, falling back to a
default and running with the wrong behaviour.

## Building a product on this

Delete what you do not need. The modules are liftable and the proofs are the evidence: each one
builds and tests standing alone outside the repository. To add a capability, add a module — the
steps are in [CONTRIBUTING.md](CONTRIBUTING.md), and the registry edit they end with is deliberately
a reviewed diff, because a new bounded context is an architectural change and that file is where a
reviewer sees it.

## What is not here yet

The reviews bounded context itself. The workspace, the spine, the edge and the gates are in place;
the domain lands through the tasks in [`docs/tasks/`](docs/tasks/), starting with TASK-0002. This
file will gain the end-to-end trace of one review submission when TASK-0007 closes.
