---
id: TASK-0009
title: Review moderation — reject, restore, and the moderator's screen
status: done
adr: [ADR-0018]
date: 2026-09-09
---

## Scope

The surface that lets a moderator remove a review from public view and undo that decision: the
`moderator` column and its migration, the `reviews.moderationList`, `reviews.reject` and
`reviews.restore` contract procedures and their implementations, the capability guard at the HTTP
boundary, the `canModerate` field in the session bootstrap payload, and the `moderation` feature
slice with the review list, its state filter, and the reject/restore mutations (screen S8). Wiring
`reviews.reject` and `reviews.restore` into the outbox so a moderation decision recomputes the
affected product's rating belongs here too.

Specifications: SPEC-0001 (screen S8, journey J7, rules 5, 9–12), SPEC-0002 (`moderator`, the
moderation-state transition), SPEC-0003 (`reviews.moderationList` / `reject` / `restore`, the
bootstrap field), SPEC-0004 (the recompute event moderation shares with submission).

## Out of scope

Reporting or flagging a review (the `pending` state stays seeded and unused). A moderation audit
trail. Bulk moderation. Granting the capability from a screen — it is set by seed or by hand
(ADR-0018).

## Acceptance criteria

- [x] `auth.app_user.moderator` exists as `boolean NOT NULL DEFAULT false`, added by its own
      migration rather than an edit to a merged one.
- [x] `reviews.moderationList`, `reviews.reject` and `reviews.restore` are declared in the contract
      before they are implemented, and appear in the generated OpenAPI document with their error
      shapes.
- [x] A request to any of the three with no session receives 401; a request with a session lacking
      `moderator` receives 403 — including a session that holds only `catalogue_manager`. Both are
      asserted against the HTTP layer, not against the guard in isolation.
- [x] Removing the capability check from the router turns a test red.
- [x] Rejecting a `published` review removes it from `reviews.listForProduct`, from the author's
      own-review lookup, and from the next `products.get`/`products.list` rating recomputation, all
      without deleting the row.
- [x] Restoring a `rejected` review reverses all three, and the restored row is byte-identical to
      the row before rejection apart from `updated_at`.
- [x] Rejecting an already-`rejected` review, or restoring an already-`published` one, is a no-op
      that returns the current row and does not enqueue a second recomputation.
- [x] A container test asserts that rejecting a review with an outstanding aggregate commits the
      outbox row in the same transaction as the state change — no window where the state changed
      and no recomputation was scheduled.
- [x] `reviews.moderationList` returns reviews regardless of moderation state, is capability-gated,
      and is the only route in the contract with that property; a test asserts an anonymous or
      non-moderator call to it still gets 401/403, not a filtered result.
- [x] The SPA renders the moderation entry point and screen only when `canModerate` is true, and the
      reject/restore actions are operable by keyboard alone with an accessible name naming the
      product and review each acts on.
- [x] A Playwright spec covers: sign in as the seeded moderator, reject a review, confirm it is gone
      from the product's public review list, restore it, confirm it is back.
- [x] `bun run extract-module reviews` still passes.

## Notes

Reject and restore are the same operation in reverse — one `UPDATE` of
`review_moderation_state_id`, reading two different target states — so the pipeline should not grow
two independent code paths that happen to look similar. The recomputation event is the same event
`reviews.submit` emits; there is no moderation-specific event type, because the worker recomputes
from the authoritative table regardless of what changed it.
