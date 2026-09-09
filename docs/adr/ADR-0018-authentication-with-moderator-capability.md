---
id: ADR-0018
title: Magic-link authentication with a two-member capability set, over a default-on security baseline
status: accepted
supersedes: [ADR-0017]
date: 2026-09-09
---

## Context

ADR-0017 opened the session model to a closed set of capability flags with exactly one member,
`catalogue_manager`, and said adding a second was a change to that record rather than a row in a
table — the mechanism that keeps a capability set from growing into a permission system unnoticed.
This record is that change.

A review site with no way to remove a review is a review site one bad-faith post away from being
unusable, and "delete it" is not a substitute for moderation: a deleted review is gone, while a
rejected one is a decision somebody can see, question and reverse. `reference.review_moderation_state`
has carried `published` / `pending` / `rejected` since SPEC-0002, and SPEC-0001 has said plainly since
the first draft that nothing sets anything but `published` — the column existed so the read path
already filtered on it, and the record named the seam: "a role on `auth.app_user`". This is that role,
named the way ADR-0017 names things: a capability, not a role.

The rest of ADR-0017 — the magic-link decision, `catalogue_manager`, better-auth held at arm's
length, the default-on baseline, the stated absence of a mail transport — is unchanged and restated
below in full, because a record is immutable and amending one clause means replacing the document.

## Decision

Authenticate with better-auth magic links over a session model with one identity dimension and a
closed set of capability flags, and turn the security baseline on by default in every fail-closed
tier.

The model:

- A session resolves to a user id **and a closed set of capability flags**. There is still
  deliberately no tenant or organization dimension: this product has one catalogue and one set of
  reviewers, and a tenancy layer that nothing uses is a boundary nobody maintains. Reviews are
  scoped by author id at the query level.
- **The capability set is closed and has two members: `catalogue_manager`** — the right to create
  and edit catalogue products — **and `moderator`** — the right to change a review's moderation
  state. Each is an independent boolean column on the app-owned user row (`auth.app_user`),
  defaulting to false; holding one implies nothing about the other. Neither is a role, a permission
  table or a policy engine, and adding a third capability is again a change to this record — the
  mechanism that stops the set growing quietly is the mechanism, not a one-time exception.
- **Moderation is post-publication and reversible.** A review is created `published` and visible
  immediately (unchanged — SPEC-0001's rule that a submission is visible to its author right away
  does not become conditional on review). A moderator may move it to `rejected`, which removes it
  from every read the way SPEC-0003 already scopes reads to `published`, and may move a `rejected`
  review back to `published`. `pending` remains seeded and unused in v1 — reserved for a future
  reporting flow this record does not add — so the moderation surface a person operates today is a
  two-state toggle, not a queue with an automatic feed.
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

The catalogue and the review list both now have a gate, and both gates are booleans a reviewer can
see the whole of. Rejecting a review is an operation with a record and an inverse, not a deletion —
an incident is a toggle away from being undone, and the review is never destroyed by a moderation
decision.

Rejecting or restoring a review changes which reviews count toward a product's rating, so the
transition emits the same recomputation event a submission does (SPEC-0004) — moderation is a
write to the authoritative table like any other, not a side channel the projection can miss.

The costs, beyond what ADR-0017 already named: two independent capabilities on one row is two
questions "can this person do X" now answers, and the day a third arrives, this record grows a
third clause rather than a table gaining a third row — that is whether the mechanism is holding,
not a cost, but it is not free either: each addition is a document to write and a review to defend,
which is slower than an `INSERT`. `pending` sits in the schema unused, a state with no writer, and a
reader of the vocabulary who does not read this record may reasonably wonder why.

**The renumbering:** citations of "ADR-0013" and "ADR-0017" across the code are not rewritten, for
the same reason ADR-0017 gave for ADR-0013: every clause they name is reproduced above unchanged,
and a mass renumbering is a diff nobody can review for a benefit nobody gets.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Pre-moderation (reviews start `pending`, need approval to appear) | Contradicts the already-specified rule that a submission is visible to its author immediately, and makes every review's first minutes depend on a moderator's availability. |
| Delete instead of reject | Destroys the evidence the decision was even made, and makes an accidental removal unrecoverable. |
| A single `moderator` capability that also grants `catalogue_manager` | Conflates two unrelated responsibilities — reviewing content and stocking the catalogue — into one flag, the opposite of what a capability model buys. |
| Use `pending` as the working state a moderator acts on (an automatic report flow sets it) | Requires the reporting/abuse feature this record does not add; building the state without a writer for it is scaffolding with nothing plugged in yet, recorded instead as a named gap. |
| Everything ADR-0017 already rejected (roles, a permissions table, a policy engine, session-embedded claims, `APP_MODE`-gated authoring) | Unchanged from ADR-0017's own table; the reasoning does not change because the set gained a member. |
