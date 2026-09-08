---
id: ADR-0006
title: Postgres is the single source of truth; projections are rebuildable; migrations are hand-written and append-only
status: accepted
supersedes: []
date: 2026-09-08
---

## Context

A review system has one obviously derived quantity — a product's average rating and review count —
and derived quantities are where consistency bugs live. If the aggregate is a second source of
truth, a failed write leaves it wrong forever and nothing can tell you it is wrong.

There is also the question of who writes DDL. Generated migrations from a schema-diffing ORM are
convenient and produce statements nobody reviewed, which is how a table gets locked for eleven
minutes during a deploy. Hand-written migrations are slower to author and are the thing that gets
read in review.

## Decision

Postgres holds all authoritative state; anything derived is a projection that can be dropped and
rebuilt from the authoritative tables; and migrations are hand-written, descriptively named,
append-only, and immutable once merged.

What follows:

- Kysely is the query builder, not an ORM — no lazy loading, no identity map, no implicit N+1, and
  SQL that reads like SQL.
- Raw SQL is allowed and its rows are parsed at the boundary (`rowAs`/`rowsAs`) rather than cast.
  A cast is a claim; a parse is a check.
- One migration folder with one global index sequence. Per-module migration folders make ordering
  across modules a matter of luck.
- A rollback in production is a forward migration. `down` exists for local iteration and is not the
  production story.
- Every table declares what its data is for and how long it is kept; append-only tables declare a
  purge horizon. A table with no retention answer grows until it is an incident.
- Redis (ADR-0007) holds queue state and nothing authoritative. Flushing it must cost throughput,
  never data — and there is a test that flushes it and asserts recovery.

## Consequences

There is exactly one place to look for the truth, and any projection can be discarded and rebuilt
when it is wrong. DDL is reviewable, so the person who has to run it has seen it. Kysely's types
come from the schema, so a renamed column is a compile error.

The costs: hand-writing migrations is slower than generating them, and the discipline only holds if
review actually reads them. Immutability means a mistake is corrected by another migration rather
than by editing history, which is more files. And a rebuildable projection is only rebuildable if
someone wrote the rebuild — that is a deliverable, not a property.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Prisma or TypeORM with generated migrations | Generated DDL that nobody reads, plus a query layer that hides the cost of what it emits. |
| Aggregate stored as authoritative state | Makes the derived value a second truth: one failed write and it is permanently wrong with no way to detect it. |
| Event sourcing | The strongest audit story available, and a large amount of machinery for a domain whose write model is "insert a review". |
| A document store for reviews | Reviews are relational — a review belongs to a product and an author, and the queries are joins and aggregates. |
| Redis as a cache of record | Any cache holding the only copy of something is authoritative state with no durability guarantee. |
