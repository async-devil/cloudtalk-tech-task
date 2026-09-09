---
id: ADR-0011
title: Database naming and structure conventions
status: superseded
supersedes: []
date: 2026-09-08
---

## Context

Schema conventions decided implicitly get decided repeatedly and differently. Half the tables end up
with an `id` column and half with `<table>_id`; some timestamps are `created_at` and some are
`createdAt` quoted into existence by an ORM; a foreign key is sometimes a uuid and sometimes a
public-facing string. Every one of those inconsistencies costs a lookup, forever.

There is also a public-identifier question. Exposing a sequential primary key leaks volume and
invites enumeration; exposing a bare uuid gives a support engineer no idea what they are looking at.

## Decision

Schema per bounded context, `snake_case` throughout, `<table>_id` as the primary key name,
prefixed opaque tokens as the only identifiers that cross the wire, and closed vocabularies as
reference tables rather than check constraints.

The conventions:

- One schema per bounded context; a module owns its tables and nothing reaches across.
- `snake_case` for every identifier — no quoted camelCase, ever.
- Primary key is `<table>_id`, so a join condition reads `review.product_id = product.product_id`
  and an unqualified `id` never appears in an ambiguous context.
- Public identifiers are prefixed tokens (`prd_…`, `rev_…`), minted centrally in `@repo/entities`.
  The prefix tells a human what they are holding, and the internal uuid never leaves the process.
- Closed vocabularies (a review's moderation state, for instance) are reference tables with a
  foreign key, not check constraints — a check constraint requires a migration to extend and cannot
  be joined for a label.
- Timestamps are `timestamptz`, always; money is minor units in an integer, never a float.
- Indexes are named for what they serve, and one is added with the query that needs it in the same
  change.

## Consequences

Schema reads uniformly, join conditions are unambiguous, and an identifier in a log line or a
support ticket announces what it is. Adding a vocabulary value is an insert rather than a migration.

The costs: `<table>_id` is more verbose than `id` and unfamiliar to contributors used to ORM
defaults. Token minting is an indirection between the database and the wire that has to be
maintained on both sides. Reference tables mean a join for a label, which is a query cost paid for
extensibility.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| `id` as the primary key name everywhere | Shorter, and produces `a.id = b.a_id` join conditions plus ambiguous unqualified `id` in every multi-table query. |
| Sequential integer keys exposed publicly | Leaks volume and invites enumeration of other users' data. |
| Bare uuids on the wire | Opaque in the right way and unreadable in the wrong one: nothing in the value says what it identifies. |
| Check constraints for closed vocabularies | Every new value is a migration, and the constraint cannot be joined to get a display label. |
| One schema for everything | Removes the boundary the module structure exists to create, at the database layer where it matters most. |
