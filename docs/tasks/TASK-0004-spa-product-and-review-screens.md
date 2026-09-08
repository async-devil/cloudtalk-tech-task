---
id: TASK-0004
title: SPA — product list, product detail, and the review submission flow
status: draft
adr: [ADR-0012, ADR-0008]
date: 2026-09-08
---

## Scope

Three feature slices under `apps/app/src/features/`: `products` (list with filter and rating
display), `product-detail` (product summary, paginated review list, aggregate), and `review-submit`
(the star-rating form, its optimistic state, and its error handling). Routes compose them; query keys
and the API client stay in `shared/`.

## Out of scope

Moderation UI. Author profiles. Anything requiring a route the API does not serve.

## Acceptance criteria

- [ ] No slice imports another slice; `shared/` imports no slice. Both directions are enforced by
      the dependency-cruiser run in CI.
- [ ] Every network call goes through `shared/api`; the no-fetch gate is green.
- [ ] Every string a user reads comes from a message map keyed by error code, not from a thrown
      error's message.
- [ ] Submitting a review while signed out routes to sign-in and returns to the product afterwards,
      preserving the in-progress rating.
- [ ] The rating control is operable by keyboard alone and announces its value; asserted in the
      accessibility e2e pass.
- [ ] The aggregate display states when it was last computed rather than implying it is live.
- [ ] A Playwright spec covers: browse, open a product, submit a review, see it in the list.

## Notes

The aggregate is eventually consistent (ADR-0014). The submitted review appears immediately because
the review list reads the authoritative table; the average may lag by a second. The UI should not
paper over that with an optimistic average — showing a number that is about to change is worse than
showing one that is honestly a moment old.
