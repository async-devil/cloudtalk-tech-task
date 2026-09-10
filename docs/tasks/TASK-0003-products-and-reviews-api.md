---
id: TASK-0003
title: The products and reviews API surface
status: done
adr: [ADR-0004, ADR-0008, ADR-0018]
date: 2026-09-08
---

## Scope

Extend `@repo/contracts` with the `products` and `reviews` namespaces, implement them in
`apps/api/src/routes/`, and wire the reviews context into the composition root. Routes: list products
with their rating aggregate, get one product, list a product's reviews with pagination, submit a
review, edit one's own review, delete one's own review. Products are addressed by slug (ADR-0016).
The catalogue authoring routes are TASK-0008.

## Out of scope

Frontend consumption (TASK-0004). Moderation endpoints. Search beyond a substring filter on product
name.

## Acceptance criteria

- [x] Every route is declared in the contract before it is implemented; an unimplemented contract
      namespace fails the build.
- [x] Write routes require a resolved session; an anonymous request receives 401 without reaching
      the pipeline.
- [x] Editing or deleting a review authored by another user returns 403, asserted at the HTTP layer
      rather than in a unit test of the guard.
- [x] List endpoints are paginated with a bounded page size; a request for an unbounded page is
      rejected, not silently capped.
- [x] The OpenAPI document generated from the contract lists every route with its error shapes.
- [x] Domain failures map to status codes in the error mapper only; no handler constructs a
      `Response` for an error case.
- [x] The rate limit applies to unauthenticated reads and to review submission, with a test that
      asserts the response headers on rejection.

## Notes

The specification this task builds is SPEC-0003. Product listing reads the projection (ADR-0014) and a review list reads the authoritative table.
That split is the whole point of the projection and should be visible in the router without a
comment explaining it.
