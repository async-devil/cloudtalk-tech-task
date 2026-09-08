---
id: TASK-0005
title: The rating aggregation worker
status: draft
adr: [ADR-0007, ADR-0014]
date: 2026-09-08
---

## Scope

The worker that consumes outbox events emitted by review writes and recomputes the affected
product's rating projection, registered in the api composition root, with the reconciler and
dead-letter path wired for it.

## Out of scope

Any aggregation beyond average rating and review count. Scheduled full rebuilds — the rebuild entry
point exists (TASK-0002); scheduling it is a separate decision.

## Acceptance criteria

- [ ] The worker recomputes from the review table; it applies no deltas.
- [ ] Processing the same event twice leaves the projection unchanged, asserted by replaying a
      delivered event.
- [ ] Killing the worker mid-recompute and restarting it converges to the correct aggregate; the
      test kills a real process against real containers.
- [ ] Flushing Redis loses no work: the reconciler re-enqueues from Postgres and the projection
      converges.
- [ ] A permanently failing event lands in the dead-letter queue after the configured ceiling and
      does not retry beyond it.
- [ ] The worker emits `reviews.rating.recompute` through the observability facade, and the module
      README's telemetry section lists it.
- [ ] Aggregation lag is measured by an instrument, so staleness is observable in the same place as
      everything else.

## Notes

The kill-and-restart test is the one that justifies ADR-0007's machinery. If it cannot be written,
the machinery is not earning its cost and the synchronous alternative in ADR-0014 should be
reconsidered.
