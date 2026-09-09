---
id: TASK-0005
title: The rating aggregation worker
status: done
adr: [ADR-0007, ADR-0014]
date: 2026-09-08
---

## Scope

The worker that consumes outbox events emitted by review writes and recomputes the affected
product's rating projection, registered in the api composition root, with the dead-letter path
wired for it. No reconciler is registered for this pipeline (amended per SPEC-0004 open question 1
— see the flushed-Redis criterion below): the relay's own pending-row scan is the recovery path a
reconciler would otherwise provide, because this pipeline has no stage pipeline for one to
reconcile.

## Out of scope

Any aggregation beyond average rating and review count. Scheduled full rebuilds — the rebuild entry
point exists (TASK-0002); scheduling it is a separate decision.

## Acceptance criteria

- [x] The worker recomputes from the review table; it applies no deltas.
- [x] Processing the same event twice leaves the projection unchanged, asserted by replaying a
      delivered event.
- [x] Killing the worker mid-recompute and restarting it converges to the correct aggregate; the
      test kills a real process against real containers.
- [x] Flushing Redis loses no work: pending rows stay in Postgres untouched by the flush, and the
      relay's own pending-row scan drains them once the composition root re-registers the
      repeatable schedule at boot — no reconciler is involved (amended per SPEC-0004 open
      question 1: this pipeline has no stage pipeline and no reconciler; the relay's claim query
      IS the recovery path).
- [x] A permanently failing event lands in the dead-letter queue after the configured ceiling and
      does not retry beyond it.
- [x] The worker emits `reviews.rating.recompute` through the observability facade, and the module
      README's telemetry section lists it.
- [x] Aggregation lag is measured by an instrument, so staleness is observable in the same place as
      everything else.

## Notes

The kill-and-restart test is the one that justifies ADR-0007's machinery. If it cannot be written,
the machinery is not earning its cost and the synchronous alternative in ADR-0014 should be
reconsidered.

The flushed-Redis criterion originally read "the reconciler re-enqueues from Postgres and the
projection converges" — written for a stage pipeline with external calls, which this workload has
neither (SPEC-0004's "why the relay applies directly"). This pipeline never registers a
reconciler; the relay's own claim query (`SELECT ... WHERE outbox_row_status_id = Pending ...
FOR UPDATE SKIP LOCKED`) already reads Postgres as the sole truth about what remains pending, so a
flushed Redis costs only the repeatable schedule, which the composition root re-registers on every
boot (`startOutboxRelay`'s `scheduleRepeatable` call is idempotent). The criterion above states
this directly; SPEC-0004 open question 1 records that the amendment happened.
