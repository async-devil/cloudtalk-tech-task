---
id: ADR-0019
title: Extending the rate-limit baseline with anonymous-read and review-submission buckets
status: accepted
supersedes: []
date: 2026-09-09
---

## Context

TASK-0003 needs two rate limits SPEC-0003 explicitly declines to add on its own authority: one on
unauthenticated reads, and one on review submission by a signed-in reviewer. The rate limiter
(`apps/api/src/http/security/rate-limit.ts`) states its two existing buckets — `auth` (every
`/api/auth/*` request) and `unauthenticated-post` (a POST with no resolved session), both keyed by
client IP — and marks that list "frozen" in a source comment citing "ADR-0013's security baseline."
SPEC-0003's own Limits section repeats the word: the list is "stated as frozen" and "this document
deliberately does not unfreeze it," proposing exactly this record.

The citation the "frozen" comment leans on is stale twice over. ADR-0013 was superseded by ADR-0017
(which added the `catalogue_manager` capability), and ADR-0017 was in turn superseded by ADR-0018
(which added `moderator`). Neither superseding record touches the bucket list: both restate the
baseline clause verbatim — "per-IP rate limits on the auth routes and on unauthenticated writes" —
because a record is immutable and each was replacing a different clause. Grepping ADR-0018 for the
bucket list, or for "anonymous-read" or "review-submission," turns up nothing: the two-bucket list
is not a decision either superseding record made or preserved by name, it is a boundary the
rate-limiter's own source comment drew for itself and then cited its neighbour's authority for. That
distinction matters for what kind of record this is. If ADR-0018 had actually fixed the bucket list
at two, extending it would be overturning an accepted decision, and this record would have to name
ADR-0018 in `supersedes`. It did not, so there is nothing here to overturn — only a baseline to
extend, the same way ADR-0017 extended ADR-0013's session model without needing to contradict it.

Two categories of traffic reach the API today with no limiter watching them at all. Every anonymous
`GET` — the catalogue, a product, a review list — is unmetered, and reading is the one thing this
product lets anyone do without a session (SPEC-0001 rule 15), which makes it the highest-volume path
in the system and the one most worth bounding. And `reviews.submit` / `reviews.update` run with a
resolved session, so they never touch `unauthenticated-post` (that bucket only ever sees a POST with
no session) and never touch `auth` (they are not `/api/auth/*`) — two write routes a hostile or
malfunctioning client could hit as fast as the network allows, entirely outside either existing
bucket's field of view.

## Decision

Add two rate-limit buckets to the existing per-request limiter — `anonymous-read` (a `GET` with no
resolved session, keyed by client IP, the same key the existing two buckets already use) and
`review-submission` (`reviews.submit` and `reviews.update` with a resolved session, keyed by the
session's internal user id) — both answering `429` through the same typed `RateLimitedError` the
existing buckets already throw.

## Consequences

Every route the read side of this contract exposes is now behind a limiter, and so are the two
writes an authenticated abuser could otherwise hammer without ever being throttled by `auth` or
`unauthenticated-post`. A rejection from either new bucket is indistinguishable on the wire from a
rejection today: the same `RATE_LIMITED` code, the same `apiErrorShape`, the same `Retry-After`
header computed from the same `retryAfterMs` — TASK-0003's header assertion exercises whichever
bucket fires without needing to know which one did.

The cost worth naming plainly: `review-submission` is the first bucket keyed by something other than
a client-IP hash. The existing buckets hash an IP-derived subject specifically so the Redis key
cannot be made to collide with another subject's internal keys (`rateLimitSubjectOf`'s documented
containment property); a bucket keyed by the session's internal user id needs that same containment,
and needs it verified the same way — by a test that tries to break it, not by inspection. And an
internal id is now a value the rate-limit store holds at all, where before it held only IP hashes.
It must never leave that store's own keyspace: ADR-0009 already forbids any id on a metric
attribute, and it stays true here — the bucket NAME (`review-submission`) is the counter's only
dimension, never the user id that earned a request its slot in the bucket, and never in a log line
either.

`anonymous-read` has a cost of its own, and it is not hypothetical: every visitor behind one shared
IP — an office, a campus, carrier-grade NAT on a mobile network — shares one bucket. A single bad
actor there can burn the shared allowance and cost their neighbours legitimate reads, which a limit
keyed on IP alone can never distinguish from one visitor reading quickly. That is the same trade-off
`unauthenticated-post` already accepted for anonymous writes; this record makes the same call for
anonymous reads instead of inventing a fairer one, because a fairer one needs an identity anonymous
traffic does not have.

Two routes this record does NOT cover, on purpose. `reviews.remove` carries neither bucket:
SPEC-0003's own bucket list omits it from `review-submission`, and a deletion is not the traffic
shape either bucket exists to bound. And `products.create`, `reviews.reject` and `reviews.restore`
are out of scope here entirely — they are not in `appContract` yet (TASK-0008, TASK-0009), and
SPEC-0003's open question 6 already argues that capability-gated moderation actions do not need a
rate limit of their own. Both are left for whichever record actually adds those routes to decide.

## Alternatives considered

| Alternative | Why rejected |
|---|---|
| Let TASK-0003 add the buckets directly, with no record | Contradicts SPEC-0003's own Limits section, which states plainly that extending a frozen security baseline is a decision, not a specification detail — the exact distinction CONTRIBUTING.md draws between the two document kinds. |
| Route anonymous reads and review writes through the two EXISTING buckets instead of adding new ones | `unauthenticated-post` only ever sees a session-less POST, so it structurally never fires for `reviews.submit`/`reviews.update` (both always carry a session) or for any `GET`; reusing it for traffic it cannot see is not an extension, it is a silent no-op dressed as one. |
| One shared `authenticated-write` bucket covering every present and future authenticated write | Folds `reviews.remove` in with `submit`/`update` against SPEC-0003's explicit exclusion, and pre-commits future routes (`products.create`, moderation actions) to a shape decided before those routes exist. A bucket that limits more traffic than the traffic it was named for hides which behaviour it actually protects. |
| Supersede ADR-0018 rather than extend it | Verified against ADR-0018's text: it names no bucket, frozen or otherwise. Superseding a record for a clause it never made would be a citation for its own sake, and the immutability rule is not a license to re-file every baseline extension as though it overturned something. |
| Key `review-submission` by client IP, matching the other three buckets | The one bucket with a resolved identity available is the one case where IP-keying is the WRONG default: it lets a single reviewer rotating networks evade the limit entirely, and it lets one shared IP's worth of distinct signed-in reviewers collide into a limit meant for one identity. |
