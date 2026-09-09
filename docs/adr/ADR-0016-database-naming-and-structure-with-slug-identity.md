---
id: ADR-0016
title: Database naming and structure conventions, with slug identity for catalogue rows
status: accepted
supersedes: [ADR-0011]
date: 2026-09-09
---

## Context

ADR-0011 settled the schema conventions this repository writes by, and all but one of them have held
without argument. The exception is the identifier rule: *public identifiers are prefixed opaque
tokens, minted centrally, and the internal uuid never leaves the process*.

That rule was written for one threat — exposing a sequential key leaks volume and invites
enumeration — and it is the right rule for the rows it was reasoned about. A review, a user: rows
that belong to a person, where being able to walk the id space is a way to read other people's data.

It is the wrong rule for a catalogue. A product is public by construction: the entire point of the
catalogue screen is to enumerate it, the search box hands out the whole list on request, and there is
nothing behind `prd_V1StGXR8Z5jdHi6BmyT` that `/products` does not already give away. What the token
does cost is real and paid on every read: a URL nobody can say out loud, a support ticket nobody can
skim, and a link that tells a person nothing about where it goes. An opaque identifier buys secrecy;
where there is no secret, it is a fee with no purchase.

There is a second thing the original rule left no room for. A catalogue product already has an
identifier in the business the software serves — a SKU — and a system that refuses to store it makes
every conversation with a warehouse a translation exercise.

The rest of ADR-0011 is unchanged and is restated below in full, because a record is immutable and
amending one clause means replacing the document.

## Decision

Schema per bounded context, `snake_case` throughout, `<table>_id` as the primary key name, opaque
prefixed tokens for user-owned rows and human-readable slugs for catalogue rows, and closed
vocabularies as reference tables rather than check constraints.

The conventions:

- One schema per bounded context; a module owns its tables and nothing reaches across.
- `snake_case` for every identifier — no quoted camelCase, ever.
- Primary key is `<table>_id`, so a join condition reads `review.product_id = product.product_id`
  and an unqualified `id` never appears in an ambiguous context.
- **Public identifiers for user-owned and user-generated rows are prefixed tokens (`rev_…`,
  `usr_…`), minted centrally in `@repo/entities`.** The prefix tells a human what they are holding,
  and the internal uuid never leaves the process.
- **Catalogue rows are addressed by a human-readable `slug`** — unique, immutable once set, and
  minted from the row's own name rather than from a random source. Enumeration is not a threat to a
  table that exists to be enumerated, and readability is worth something on every link, log line and
  support ticket. A catalogue row that carries a business identifier (a SKU) stores it as its own
  unique column; a business identifier is data, not an address, and the two are never the same
  column.
- The internal uuid still never leaves the process, for either kind. The change is which public
  identifier a row carries, never whether it has one.
- Closed vocabularies (a review's moderation state, for instance) are reference tables with a
  foreign key, not check constraints — a check constraint requires a migration to extend and cannot
  be joined for a label.
- Timestamps are `timestamptz`, always; money is minor units in an integer, never a float.
- Indexes are named for what they serve, and one is added with the query that needs it in the same
  change.

## Consequences

Everything ADR-0011 bought is still bought: schema reads uniformly, join conditions are unambiguous,
and an identifier in a log line announces what it is. Product URLs are now readable and stable, and
the SKU a warehouse already uses is a column rather than a lookup.

The costs, and they are not small. **A slug is mutable data pressed into service as an address**, so
it has to be frozen by an invariant the database cannot express — a check constraint cannot see the
old row — which means the rule lives in the pipeline and is only as good as the test that proves it.
Renaming a product no longer renames its URL, which is the price of links that do not rot. Slug
minting can collide where token minting could not, so creation has a conflict path that token
creation never needed. And the repository now holds two identifier rules where it held one, so
"which kind of row is this" is a question every new table has to answer.

**The renumbering, stated so nobody has to wonder.** Roughly eighty comments, tests and gate
messages across `packages/`, `apps/` and `tools/` cite "ADR-0011". They are deliberately not
rewritten: every clause they cite is reproduced above without change, and a mass renumbering would
be a large diff no reviewer can meaningfully check, in exchange for nothing a reader was missing. A
citation of ADR-0011 remains a correct citation of the rule it names; this record is where that rule
now lives.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep ADR-0011 as written (tokens everywhere) | Correct for reviews and users; on a public catalogue it is a fee with no purchase — an unreadable URL protecting a list the search box hands out anyway. |
| Slug *and* token on the same row | Two public identifiers for one row, and every consumer must know which one to store. The one that is never wrong to store is the one that should exist. |
| Address products by SKU | One identifier, business-meaningful — and a URL that reads like a warehouse, plus a SKU that can never be corrected because it became an address. |
| Slug plus a permanent redirect history table | The rename-safe answer, and the right one for a catalogue with public traffic and SEO. It is a table, a lookup on every 404 and a retention question, bought for a catalogue that has neither yet. |
| A slug generated from a token (`sony-headphones-V1StGXR8`) | Readable and collision-free, and it reintroduces the noise the change exists to remove. |
| Amend ADR-0011 in place | The contract forbids it, for the reason this document is long: a decision people have already read must not change under them. |
