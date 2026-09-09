---
id: TASK-0002
title: The reviews bounded context — schema, migrations, and the submission pipeline
status: ready
adr: [ADR-0006, ADR-0007, ADR-0014, ADR-0016]
date: 2026-09-08
---

## Scope

Add `packages/reviews`: the bounded context owning products, reviews, and the rating projection.
Its migration adds the product table, the review table, the moderation-state reference table, and
the `product_rating` projection table with its computed-at timestamp. Its pipeline implements review
submission following the six-step shape in ADR-0007 — state check, advisory-lock claim, write, single
commit, outbox emission — and exposes a rebuild entry point for the projection.

## Out of scope

The HTTP surface (TASK-0003), the aggregation worker itself (TASK-0005), and any moderation
decision logic beyond storing the state.

## Acceptance criteria

- [ ] `product`, `review`, `review_moderation_state` and `product_rating` exist, following ADR-0016:
      `snake_case`, `<table>_id` primary keys, `timestamptz` timestamps.
- [ ] A product is addressed by a unique `slug` and carries a unique `sku`; a review's public
      identifier is a minted `rev_…` token; no internal uuid appears in any exported type.
- [ ] A product's `slug` and `sku` cannot be changed after creation, and the test that proves it
      fails when the guard is removed.
- [ ] A unique constraint enforces one review per author per product, and the violation surfaces as
      a typed `AppError`, not a raw driver error.
- [ ] Submitting a review writes the review row and its outbox row in one transaction; a container
      test asserts that no committed review lacks an outbox row.
- [ ] Re-running a submission with the same deterministic id is a no-op that returns the existing
      review.
- [ ] `rebuildProductRating` recomputes a product's aggregate from the review table and is proven
      idempotent by running it twice and comparing.
- [ ] A container test drops the entire `product_rating` table, rebuilds it, and asserts it matches
      a recomputation from the authoritative rows.
- [ ] The module lifts: `bun run extract-module reviews` passes.

## Notes

The specification this task builds is SPEC-0002. The rating column is a numeric constrained to 1–5
at the database level as well as in the schema.
Two layers for one rule is deliberate: the Zod schema is the message a user reads, and the constraint
is what holds when something writes without going through it.
