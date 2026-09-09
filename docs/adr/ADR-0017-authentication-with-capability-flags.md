---
id: ADR-0017
title: Magic-link authentication with a single-tenant session model carrying capability flags, over a default-on security baseline
status: accepted
supersedes: [ADR-0013]
date: 2026-09-09
---

## Context

ADR-0013 settled authentication and the security baseline, and its session model was one sentence: a
session resolves to a user id and nothing else. That was true and sufficient while every signed-in
person could do exactly the same things — write a review, edit their own, delete their own — and
ownership was the only question authorization ever had to answer.

The catalogue changes that. Products are now created and edited in the application rather than
arriving only by seed, and "who may add a product to the catalogue" is not an ownership question:
there is no owner to compare against before the row exists. A system that answers it with "anyone
signed in" is a system whose catalogue is an open text field with a rate limit in front of it.

So the session needs to carry something beyond identity. The danger is what that something becomes:
roles that accumulate, a permissions table nobody can reason about, a policy engine with its own
language. That progression starts with the word "role", which is why this record does not use it.

The rest of ADR-0013 — the magic-link decision, better-auth held at arm's length, the default-on
baseline, the stated absence of a mail transport — is unchanged and restated below in full, because
a record is immutable and amending one clause means replacing the document.

## Decision

Authenticate with better-auth magic links over a session model with one identity dimension and a
closed set of capability flags, and turn the security baseline on by default in every fail-closed
tier.

The model:

- A session resolves to a user id **and a closed set of capability flags**. There is still
  deliberately no tenant or organization dimension: this product has one catalogue and one set of
  reviewers, and a tenancy layer that nothing uses is a boundary nobody maintains. Reviews are
  scoped by author id at the query level.
- **The capability set is closed and currently has exactly one member: `catalogue_manager`** — the
  right to create and edit catalogue products. It is a boolean column on the app-owned user row
  (`auth.app_user`), defaulting to false. It is not a role, not a permission table and not a policy
  engine, and adding a second capability is a change to this record rather than a row in a table —
  which is the mechanism that stops the set growing quietly.
- **A capability is enforced at the boundary and merely reflected in the client.** The session
  bootstrap payload tells the SPA what to render; the server refuses regardless of what the client
  believes, and the test that proves it calls the route without the capability and expects 403.
  Ownership checks are unchanged and remain per-row.
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
click. The session model is still small enough to hold in your head, and the security measures are on
before anyone thinks to ask for them. The catalogue has a gate, and the gate is one boolean a
reviewer can see the whole of.

The costs: magic links depend on email deliverability and add a mailbox round-trip to every sign-in.
Removing the tenant dimension means adding one later is a migration and a change to every scoped
query. The missing mail transport means sign-in in a real deployment is one integration away. And
authorization now exists, which means it can be got wrong: a capability checked in the SPA and
forgotten on the server is a hole that looks closed in every screenshot, so the assertions live at
the HTTP layer. Granting the capability is a database update with no surface of its own — deliberate
for a system with one manager and the wrong answer the moment there are ten.

**The renumbering:** citations of "ADR-0013" across `packages/auth`, `apps/api` and the gates are not
rewritten. Every clause they name is reproduced above unchanged, and a mass renumbering would be a
diff nobody can review for a benefit nobody gets.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Keep ADR-0013 as written; any signed-in user may create products | No new concept, and the catalogue becomes an open text field with a rate limit in front of it. |
| A role table with a join (`user_role`, `role_permission`) | The shape everyone reaches for, and it answers a question this product does not have: one capability does not need a join, and the table is what makes ten of them arrive unnoticed. |
| A policy engine or attribute-based rules | Powerful, and a language to learn plus a second place authorization can be wrong. |
| Gate authoring on `APP_MODE === 'test'` | No authorization model at all, and a page that does not exist in the deployed product — which makes the deployed product's catalogue unmaintainable. |
| Capability claims baked into the session cookie | Fast, and revocation becomes a second system: a demoted manager keeps the capability until their session expires. |
| Email and password / OAuth / anonymous reviews / multi-tenant sessions / JWTs in local storage | Unchanged from ADR-0013: obligation without benefit, setup friction before the first run, unimplementable ownership, an unused boundary, and an XSS-readable credential respectively. |
