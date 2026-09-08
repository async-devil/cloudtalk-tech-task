---
id: ADR-0007
title: BullMQ over Redis for async work, behind a durability spine with an outbox, reconciler and dead-letter queue
status: accepted
supersedes: []
date: 2026-09-08
---

## Context

Work that must not block a request — recomputing a product's rating aggregate, running a review
through moderation, sending mail — needs a transport. Redis-backed queues are the pragmatic choice
at this size: no broker to operate, and Redis is already useful for rate limiting.

The hard part is not the transport. It is that a queue plus a handler is not durable. Redis is not
the source of truth (ADR-0006), so a flush loses in-flight jobs; a worker that crashes between an
external call and its database write either loses the work or repeats it; and a job that fails
forever needs somewhere to go that is not an infinite retry loop.

## Decision

Use BullMQ over Redis as the transport, and put every job behind a durability spine: a transactional
outbox for cross-process fan-out, a six-step idempotency shape for every worker, a reconciler that
re-enqueues work Postgres says is unfinished, and a dead-letter queue with a bounded ceiling.

The six-step shape, which every worker follows:

1. Check state — if the work is already done, return; this is what makes replay a no-op.
2. Claim with an advisory lock — two workers on the same row do not both proceed.
3. Make the external call **outside** any transaction — never hold a transaction open across a
   network call to a third party.
4. Write ahead — record the outcome before acknowledging it anywhere else.
5. Commit once — a single commit per stage, so a crash lands either side of it cleanly.
6. Enqueue downstream work through the outbox, in that same transaction.

Supporting rules: never enqueue without a deterministic job id (that id is what makes redelivery
idempotent); the outbox exists only at real cross-process fan-out points, not as a general write
path; and the reconciler treats Postgres as the truth about what remains to be done, which is what
makes a Redis flush a throughput event rather than a data-loss event.

## Consequences

A crash at any point in a job leaves the system recoverable, and the recovery path is exercised by
container-backed tests that kill workers and flush Redis rather than argued for in prose. Replay is
safe by construction. A poison message stops after a bounded number of attempts and is visible
rather than silently spinning.

The costs are substantial and worth naming: the spine is more code than "enqueue and handle", and
every worker author has to learn the six steps. Redis is a second piece of infrastructure to run.
Advisory locks are a shared resource with their own contention story. This is the machinery the
system buys for one property — that no acknowledged work is silently lost — and if a future
capability does not need that property, it should not pay for it.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| BullMQ with no outbox or reconciler | The common setup, and its failure mode is silent: a crash between the external call and the write loses the work with no signal anywhere. |
| Postgres-only queue (`SKIP LOCKED`) | Genuinely attractive — one datastore, transactional enqueue. Rejected because the rate limiter and its sliding windows want Redis anyway, so Postgres-only saves no infrastructure here. |
| Kafka or RabbitMQ | Ordering and throughput guarantees this workload does not need, with a broker to operate. |
| Synchronous processing in the request | Ties review submission to moderation latency and gives the user a timeout instead of a receipt. |
| `setTimeout` / in-process background work | Lost on every deploy and every crash, and invisible when it fails. |
