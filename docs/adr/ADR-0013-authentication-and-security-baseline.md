---
id: ADR-0013
title: Magic-link authentication with a single-tenant session model, over a default-on security baseline
status: superseded
supersedes: []
date: 2026-09-08
---

## Context

Reviews are attributable: a review has an author, an author can edit their own review and not
someone else's, and "one review per product per person" is only meaningful if there is a person.
So the system needs identity — but identity is not what this system is about, and every hour spent
on a password reset flow is an hour not spent on reviews.

Passwords bring their own permanent obligations: storage, rotation, breach response, and a reset
flow that is itself an attack surface. Email-link authentication removes all of them and moves the
trust to the mailbox, which is where a password reset already puts it.

The security baseline is a separate question with a simple answer: the measures are cheap, and
adding them after an incident is expensive.

## Decision

Authenticate with better-auth magic links over a session model with exactly one dimension — a user
— and turn the security baseline on by default in every fail-closed tier.

The model:

- A session resolves to a user id and nothing else. There is deliberately no tenant or organization
  dimension: this product has one catalogue and one set of reviewers, and a tenancy layer that
  nothing uses is a boundary nobody maintains. Reviews are scoped by author id at the query level.
- better-auth is held at arm's length inside `packages/auth`; no other module imports it. The one
  named exception is the SPA's auth client, which is a single file, because the browser must never
  reach the server SDK.
- The baseline, on by default outside `test`: security headers, a credentialed CORS allow-list of
  exact origins (a wildcard with credentials is structurally unconstructible, not merely
  discouraged), a JSON body cap, per-IP rate limits on the auth routes and on unauthenticated
  writes, and a per-address ceiling on magic-link sends so one client cannot direct unlimited mail
  at one victim.
- Client IP is read from `X-Forwarded-For` only when explicitly trusted. The flag parses as a strict
  boolean — coercing an env string through JavaScript's `Boolean()` turns `'false'` into `true` and
  silently inverts an operator's decision.

**A limitation stated plainly:** there is no production mail transport in this repository. The
magic-link sender is a development adapter that logs the link, and a fail-closed tier refuses to
boot without a real one configured. Wiring a provider is a composition-root change (ADR-0005) and
was left undone deliberately rather than half-done — the port, the renderer and the rate limit are
all in place and tested.

## Consequences

No password storage, no reset flow, no credential-stuffing surface. Sign-in is two fields and a
click. The session model is small enough to reason about, and the security measures are on before
anyone thinks to ask for them.

The costs: magic links depend on email deliverability and add a mailbox round-trip to every sign-in,
which is friction on a shared device. Removing the tenant dimension means adding one later is a
migration and a change to every scoped query — a deliberate bet that this product will not need it.
And the missing mail transport means sign-in in a real deployment is one integration away.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Email and password | Storage, rotation, breach response and a reset flow that is itself an attack surface — all of it obligation, none of it this product's problem. |
| OAuth with social providers | Good user experience, provider registration and secrets before anything runs locally, which fights the one-command setup the brief asks for. |
| Anonymous reviews with no identity | Simplest, and it makes "one review per person" and "edit your own review" unimplementable. |
| Multi-tenant sessions with row-level security | The right answer for a product with tenants; this one has none, and an unused boundary is one nobody maintains correctly. |
| JWTs in local storage | Readable by any XSS, and revocation becomes a second system. Server sessions in `HttpOnly` cookies have neither problem. |
