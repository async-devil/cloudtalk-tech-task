---
id: SPEC-0004
title: Aggregation and events — the outbox, the relay, and the rating projection
status: draft
supersedes: []
adr: [ADR-0007, ADR-0009, ADR-0014]
date: 2026-09-09
---

## Context

ADR-0014 decided that a product's rating aggregate is recomputed asynchronously from the
authoritative reviews. TASK-0005 states what the worker must survive — redelivery, a kill mid-write,
a flushed Redis, a permanently failing event — without saying what it consumes, what it writes, or
which of the spine's parts it uses. This document says.

What exists: the durability spine in `@repo/jobs` — `insertOutboxRows`, `relayOutboxBatch`,
`startOutboxRelay`, `writeDeadLetter`, `purgeDeadLetters`, the reconciler and the retention pass —
and `@repo/messaging`'s BullMQ transport with `jobIdFor` for deterministic job ids. The four spine
vocabularies are seeded in `reference` (`0002-create-jobs-spine.ts`).

## Specification

### The shape, in one paragraph

A review write inserts its row **and** an outbox row in one transaction. A scheduled relay claims
pending outbox rows (`FOR UPDATE SKIP LOCKED`), and for each one recomputes that product's aggregate
from the authoritative reviews and upserts `reviews.product_rating` — then marks the row processed in
the same pass's single commit. There is no per-product BullMQ job in between, and that absence is the
design (see "Why the relay applies directly").

### `reviews.outbox`

Each bounded context owns its own outbox table; the spine takes it as an `OutboxTableRef`
(`{ schema, table }`) and never string-builds a name. Created by
`packages/persistence/migrations/0004-create-reviews.ts` in the shape the spine reads, specified in
SPEC-0002 alongside the rest of the schema.

### The event

One operation, emitted by all three write paths:

| Field | Value |
|---|---|
| `aggregate_id` | the product's **internal** `product_id` — the row never leaves the process, and the relay resolves nothing to send |
| `op` | `rating.recompute` |
| `payload` | `{}` — no rating, no delta, no review id |

The payload is empty on purpose. A recomputation reads the authoritative table; anything carried in
the payload would be a second, staler copy of what the worker is about to read, and the moment it
disagreed the projection would take the payload's word for it. Submission, edit and deletion all emit
the identical event: the aggregate does not care what changed, only which product changed.

**Creating a product emits nothing.** There is no review to aggregate, so no recomputation is owed
and no `product_rating` row exists — which is why every catalogue read joins the projection `LEFT`
(SPEC-0002). Inserting a zero row at creation to avoid the null would be a projection claiming a
`computed_at` for a computation that never ran, and the UI would display that claim faithfully.

Deletion emits before its cascade takes effect, in the same transaction — the recomputation reads
whatever the committed state is, which is the point of recomputing rather than adjusting.

### The write path (ADR-0007's six steps)

For `reviews.submit`, and the same shape for update and delete:

1. **State check** — outside any transaction: does this author already have a review on this product?
   The answer is advisory only; the unique constraint is the guarantee.
2. **Claim** — a transaction-scoped advisory lock keyed by `(product_id, author_id)`, so two
   simultaneous submissions from one author serialize rather than racing to the same constraint
   violation.
3. **External call outside the transaction** — there is none. Review submission calls no provider,
   and the step is named here so its absence is a fact rather than an omission.
4. **Write-ahead** — not applicable for the same reason: there is no paid call to make idempotent.
5. **Single commit** — the review row and the outbox row are inserted and committed together
   (`insertOutboxRows(trx, …)` inside the same transaction). **There is no window in which a
   committed review has no scheduled recomputation** — TASK-0002 asserts exactly that against
   containers.
6. **Typed failure** — the unique-constraint violation becomes `ConflictError`; nothing raw escapes
   (ADR-0008).

Idempotence of the write itself is by deterministic id: re-running a submission with the same id is a
no-op that returns the existing review, and emits no second event.

### The relay

`startOutboxRelay({ db, outbox: { schema: 'reviews', table: 'outbox' }, apply, everyMs, batchSize,
maxAttempts })`, registered at the API composition root (`apps/api/src/runtime/`, ADR-0005) and
running as a repeatable scheduled worker.

`apply(row)` is `recomputeProductRating(db, row.aggregateId)`:

```sql
INSERT INTO reviews.product_rating (product_id, review_count, rating_average, computed_at)
SELECT $1, count(*), CASE WHEN count(*) = 0 THEN NULL ELSE round(avg(rating), 2) END, now()
  FROM reviews.review
 WHERE product_id = $1 AND review_moderation_state_id = 1
ON CONFLICT (product_id) DO UPDATE
   SET review_count   = excluded.review_count,
       rating_average = excluded.rating_average,
       computed_at    = excluded.computed_at
```

- **A recompute, never a delta** (ADR-0014). A delta is a second source of truth that drifts; a
  recompute is idempotent, and idempotence is what makes at-least-once redelivery safe.
- **Upsert, not update** — the projection row may be absent (a never-rated product) or may have been
  dropped wholesale by a rebuild.
- `computed_at` moves on every application, including one that changes no other column. The UI's
  staleness line is a claim about when the number was *checked*, not when it last *changed*.
- Only `published` reviews count, so the moderation state that nothing can set yet is already
  respected by the projection.

**Failure handling is the relay's, not the worker's.** A throw from `apply` increments `attempts` and
records `last_error`; at `maxAttempts` the row is parked `dead` and a `jobs.dead_letter` row is
written for triage (pipeline `reviews`, the parked reason, the attempt count). A poison row wedges
only itself: sibling rows in the same pass still commit.

### Why the relay applies directly

The alternative — the relay enqueues a BullMQ job per product and a worker recomputes — was
considered and rejected. The enqueue happens *before* the row is marked processed only if the mark is
deferred until the job completes, which the spine does not do; mark-then-enqueue moves the durability
boundary from Postgres into Redis, and TASK-0005's own criterion ("flushing Redis loses no work") is
exactly the failure that design admits. Recomputing an average is a bounded, indexed aggregate over
one product's reviews with no external call, so there is nothing a second hop buys.

The consequences of this choice, stated so nobody has to rediscover them:

- **Recovery is the relay's pending scan**, not the reconciler. Rows stay `pending` until applied, so
  a process killed mid-recompute loses nothing, and a flushed Redis costs only the repeatable
  schedule, which the composition root re-registers at boot. TASK-0005's reconciler criterion is
  written for a stage pipeline with external calls; this pipeline has neither stages nor calls, and
  the same guarantee is delivered by the relay itself (see Open question 1).
- **Throughput is one relay pass at a time per outbox.** At catalogue scale that is ample. The seam
  if it stops being ample: `apply` enqueues, and the outbox row is marked only when the job reports
  completion — which is the stage pipeline, and which is why the spine has one.

### Rebuild

`rebuildProductRating(db, { productId? })` — one product, or the whole table when omitted —
recomputes from the authoritative reviews with the same statement the relay applies, in batches.

It is proven, not assumed (TASK-0002): run it twice and compare (idempotent); drop the entire
`product_rating` table, rebuild, and compare against a recomputation from the authoritative rows.
A projection nobody has ever rebuilt is not rebuildable.

Scheduling a periodic full rebuild is deliberately not specified — the entry point exists; scheduling
it is a separate decision (TASK-0005's own out-of-scope line).

### Retention

`reviews.outbox` accumulates `processed` rows and, rarely, `dead` ones. The horizons are the
composition root's, applied by the spine's retention pass: processed rows are purged well after
`staleAfterMs`, parked rows kept longer because they are the triage record. Dead-letter rows are
purged per pipeline via `purgeDeadLetters({ pipeline: 'reviews', … })`, the mechanism the registry
already documents for `jobs.dead_letter`.

### Telemetry

Through the facade only, `{module}.{object}.{verb}` (ADR-0009):

| Signal | Name | Attributes |
|---|---|---|
| Span | `reviews.rating.recompute` | none carrying ids |
| Counter | `reviews.rating.recompute` | `outcome` |
| Histogram | `reviews.rating.lag` | `outcome` |
| (spine, existing) | `jobs.outbox.*` backlog, relay, run | `queue` |

`reviews.rating.lag` is the ms between the outbox row's `created_at` and the moment its recomputation
commits — the number that answers "how stale can the average on the product page be", measured rather
than assumed (TASK-0005). **No product id, review id or token appears in any metric attribute**
(ADR-0009 cardinality); ids belong in span attributes and log fields, which are not a time series.

The reviews module README lists these three, as every module's telemetry section does, and the
telemetry-map gate is what keeps that list honest.

### What the tests must prove

Restating TASK-0005's criteria in this document's vocabulary, because they are the reason ADR-0007's
machinery is paid for at all:

1. Replaying a delivered outbox row leaves `product_rating` byte-identical apart from `computed_at`.
2. Killing the relay process mid-recompute and restarting it converges — against real containers,
   with a real kill, not a mocked rejection.
3. Flushing Redis loses no work: the pending rows are still in Postgres and the re-registered
   schedule drains them.
4. A row whose application always throws is parked after exactly `maxAttempts` and retries no further.
5. The lag instrument records a value on every pass.

## Open questions

1. **TASK-0005's reconciler criterion** assumes the stage pipeline. This specification delivers the
   same guarantee through the relay's pending scan and says so. Either the task's wording is amended
   or a stage pipeline is introduced for a workload that has no stages; the first is proposed.
2. **Erasure and product deletion** leave the projection stale until something recomputes (SPEC-0002
   open question 1). Proposal: both emit the same `rating.recompute` event before their cascade.
3. **Relay interval.** Not fixed here — it is the staleness budget in milliseconds, and it belongs
   with the other operational knobs at the composition root. SPEC-0001 promises "within seconds",
   which any interval under a second or two satisfies.
4. **Backlog alerting.** The spine already emits an outbox backlog age; no threshold is specified,
   because nothing in this repository ships alerting rules. The instrument exists so that it can be.

## Traceability

| Part of this specification | Constrained by | Implemented by |
|---|---|---|
| `reviews.outbox`, the event and its empty payload | ADR-0007 | TASK-0002 |
| Review write + outbox row in one transaction | ADR-0007, ADR-0014 | TASK-0002 |
| Six-step shape, advisory-lock claim, typed conflict | ADR-0007, ADR-0008 | TASK-0002 |
| The relay, its `apply`, and the upsert statement | ADR-0014 | TASK-0005 |
| Dead-letter and parking behaviour | ADR-0007 | TASK-0005 |
| `rebuildProductRating` and its proofs | ADR-0014, ADR-0010 | TASK-0002 |
| Retention horizons | ADR-0006 | TASK-0005 |
| Spans, counters, the lag histogram, cardinality | ADR-0009 | TASK-0005 |
| Durability tests against real containers | ADR-0010 | TASK-0005 |
| Staleness the UI displays | ADR-0014 | TASK-0004 |
| No event on product creation; the `LEFT JOIN` that follows | ADR-0014 | TASK-0008 |
