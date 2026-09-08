---
id: ADR-0014
title: A product's rating aggregate is an outbox-driven projection, not authoritative state
status: accepted
supersedes: []
date: 2026-09-08
---

## Context

Every product page shows an average rating and a review count, and every product list sorts and
filters by them. Recomputing `avg(rating)` across a product's reviews on each page view is a
sequential scan of the one table that grows without bound — fine at a thousand reviews, a problem at
a million, and the shape of query that looks fine in development and falls over under real traffic.

So the aggregate is stored. The question is what "stored" means, and there are three real answers.

**Update it in the same transaction as the review insert.** Simple, immediately consistent, and it
makes the aggregate authoritative state: one bug, one failed deploy, one manual data fix, and the
number is permanently wrong with nothing able to detect it. It also serializes every write to a
popular product on a single row — the hot-row problem, which arrives exactly when the product
becomes successful.

**Update it in a database trigger.** Same consistency, same hot row, and the logic now lives where
no test in this repository can see it and no code review is likely to look.

**Recompute it asynchronously from the authoritative reviews.** The aggregate becomes derived data
that can be dropped and rebuilt at any time, writes do not contend, and the cost is that the number
can lag its inputs by the time the job takes.

The lag is the whole trade, and for this domain it is nearly free: nobody can distinguish an average
rating that is two seconds stale from one that is current, and the review the author just submitted
is visible in the review list regardless, because that list reads the authoritative table.

## Decision

A product's rating aggregate is a projection recomputed asynchronously — the review write emits an
outbox event in its own transaction, a worker recomputes that product's aggregate from the
authoritative reviews, and the projection may be dropped and rebuilt from scratch at any time.

What this commits to:

- The review insert and its outbox row commit together. There is no window where a review exists and
  its recomputation was never scheduled.
- The worker recomputes from the reviews table rather than applying a delta. A delta is a second
  source of truth that drifts; a recompute is idempotent, and idempotence is what makes redelivery
  safe (ADR-0007).
- The projection carries the timestamp it was computed at, so staleness is observable rather than
  inferred.
- A rebuild command exists and is tested. A projection nobody has ever rebuilt is not rebuildable.
- Reads that must be exact — an author checking their own submission — read the authoritative table.
  Only aggregate display reads the projection.

## Consequences

Writes do not contend on a shared row, so a product going viral does not serialize its own reviews.
The aggregate can always be repaired, because the inputs are still there — a class of incident that
becomes a one-line command rather than a data-archaeology exercise. Recomputation cost is
proportional to a product's review count and is paid off the request path.

The costs: the number is eventually consistent, and the UI has to be honest about that rather than
implying otherwise. This is the decision that requires the whole jobs spine — the outbox, the
reconciler, the dead-letter queue — so a reader asking "why is there so much machinery for a review
form?" is asking a fair question, and this record is the answer. If the system only ever needed
synchronous aggregation, ADR-0007's machinery would not be worth its weight.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Recompute `avg(rating)` per read | No storage, no staleness, and a full scan of the largest table on the most frequent query. Degrades exactly as the product succeeds. |
| Update the aggregate in the review's transaction | Immediately consistent, and it makes derived data authoritative: permanently wrong after one bug, with no detection. Also serializes writes per product. |
| A database trigger | The same consistency and hot-row properties, with the logic in the one place this repository's tests and reviews cannot reach. |
| A materialized view refreshed on a schedule | Close, and refresh granularity is the whole view rather than the product that changed, so cost scales with the catalogue instead of with the change. |
| Cache the aggregate in Redis with a TTL | Fast, and it puts a derived value in a store with no durability guarantee, then hides staleness behind a timer nobody tunes. |
