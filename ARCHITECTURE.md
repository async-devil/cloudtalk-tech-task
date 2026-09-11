# Architecture

The narrative walk. [README.md](README.md) is the map and [`docs/adr/`](docs/README.md) holds the
decisions; this file explains how the pieces move.

## The shape

One deployable system, composed of workspace modules, each a bounded context. Four tiers, and
imports only ever point down them:

```
        apps/api   apps/app                  composition roots — no domain logic
              ↓
  persistence  jobs  auth  styles  reviews    capability modules
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

## One review submission, end to end

The three lifecycles above are abstract; this is the concrete path a `POST
/api/products/{slug}/reviews` takes, module by module, from the request to the aggregate a later
page load reads.

```
1. apps/api (HTTP edge)        security headers, CORS, the `review-submission` rate-limit bucket
                                 (ADR-0019), then the mounted oRPC handler.
2. @repo/auth                   resolveRequestSession resolves the caller from the session cookie;
                                 no session → 401 before anything below runs.
3. @repo/contracts               Zod parses the body against `reviewSubmitInputSchema` — untrusted
                                 becomes trusted here, and nowhere else (ADR-0004).
4. apps/api/src/routes/reviews  reviews.router.ts's `submit` handler calls straight into the
                                 bounded context — no SQL of its own, a router never reaches into
                                 `reviews.*` tables (ADR-0001).
5. @repo/reviews                 `submitReview` (ADR-0007's six steps): resolves the product,
                                 reads for an existing (product_id, author_id) row OUTSIDE a
                                 transaction (replay/conflict short-circuits here with no lock
                                 taken), then — only for a genuine new review — opens ONE
                                 transaction: advisory-lock claim, `INSERT INTO reviews.review`,
                                 and `emitRatingRecompute` writing a `reviews.outbox` row, both in
                                 the SAME commit (ADR-0006, ADR-0007). No external call and no
                                 write-ahead step: there is no provider in this path.
6. @repo/persistence              `rowAs` parses the inserted row against `reviewRowSchema` before
                                 anything downstream sees it (ADR-0004).
7. apps/api (HTTP edge)         the handler returns the review summary immediately — the commit
                                 above is already durable, and nothing past this point is on the
                                 request's critical path.
```

The response is back in the browser with the new review visible in the list (SPEC-0003: review
reads hit the authoritative `reviews.review` table, never the aggregate) before the rating has
recomputed at all. What happens next, off the request:

```
8. apps/api/src/runtime/        reviews-rating-worker.ts's outbox relay — `startOutboxRelay`
   reviews-rating-worker.ts     (@repo/jobs) on a `@repo/messaging` (BullMQ) repeatable schedule —
                                 claims the pending `reviews.outbox` row under its own advisory
                                 lock and calls `apply`, which IS `recomputeProductRating`
                                 (@repo/reviews) with no wrapper (SPEC-0004).
9. @repo/reviews                 `recomputeProductRating` upserts `reviews.product_rating` from
                                 `reviews.review` (never incrementally — ADR-0014) inside the
                                 relay's own transaction, and records the `reviews.rating.recompute`
                                 span/counter and the `reviews.rating.lag` histogram through
                                 @repo/observability's facade (ADR-0009) — the lag is measured from
                                 THIS outbox row's `created_at`, so a slow relay pass is visible,
                                 not silent.
10. @repo/jobs                   marks the outbox row processed in that same commit; a crash before
                                 it just leaves the row `pending` for the next pass to pick up again
                                 — replay-safe because `recomputeProductRating` reads the whole
                                 table, not a delta.
```

A product page's next load reads `reviews.product_rating` fresh. Between step 7 and step 10 the
average is briefly the pre-submission value while the review itself is already visible — the
eventual-consistency trade [ADR-0014](docs/adr/ADR-0014-rating-aggregation-as-a-projection.md)
makes deliberately, in exchange for never holding the review's own commit hostage to a recompute.
The projection can be dropped and rebuilt at any time (`rebuildProductRating`, used by the seed
script and available for an operational rebuild) because every input it needs — the reviews
themselves — is still sitting in `reviews.review`, untouched by any of this.

## What is not here yet

Nothing load-bearing. Every screen, route and worker the specifications describe is built; what
remains is tracked follow-up, not a gap in the shape above — a real mail provider behind the
magic-link port (ADR-0013) chief among them, plus a couple of Playwright specs still gated on
wiring seed data into the e2e harness ([`docs/tasks/TASK-0004`](docs/tasks/TASK-0004-spa-product-and-review-screens.md)).
[README.md](README.md)'s "Known limitations" section states the rest plainly. Where to add the NEXT
bounded context is [CONTRIBUTING.md](CONTRIBUTING.md)'s job to answer, not this file's.
