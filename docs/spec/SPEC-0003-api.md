---
id: SPEC-0003
title: The API — contract namespaces, wire shapes, pagination and failure
status: draft
supersedes: []
adr: [ADR-0004, ADR-0008, ADR-0016, ADR-0018]
date: 2026-09-09
---

## Context

TASK-0003 names six routes in one sentence and states that every one must be declared in the contract
before it is implemented; the catalogue authoring surface (SPEC-0001 screen S7) adds two more. This document is that declaration in prose: every procedure with its
method, path, session requirement, input, output, failure codes and limits — enough to write
`@repo/contracts` from, and enough to review the implementation against.

What exists: the composed `appContract` with its `session` namespace
(`packages/contracts/src/contracts/app-contract.ts`), the uniform wire error shape
(`error-shape.ts`, deriving its `code` enum from `@repo/kernel`'s `ERROR_CODES`), the Elysia edge
mounting the contract under `/api`, the error mapper that is the only place a domain failure becomes
a status code (`apps/api/src/http/error-mapper.ts`), and the session middleware (`@repo/auth`).

## Specification

### Shape of the contract

Two new namespaces beside `session`, nested in `appContract` — nesting is what the SPA's client and
the query-key factory mirror, and it does not touch the wire, since oRPC's OpenAPI handler routes on
each procedure's own declared `route.path`:

```
packages/contracts/src/contracts/
  app-contract.ts          # + products, reviews
  products/products.ts     # productsContract
  reviews/reviews.ts       # reviewsContract
  shared/page.ts           # cursorPageSchema / pageOf
```

Contract-first is absolute (ADR-0004): a route is declared here before it is implemented, and a
handler that is not a contract implementation cannot exist. Declaring a `route.path` is also what
keeps the RED metric's `route` attribute bounded — `apps/api/src/http/route-template.ts` walks the
contract for its template list, so an undeclared path would report as `other`.

Implementations live in `apps/api/src/routes/products/products.router.ts` and
`apps/api/src/routes/reviews/reviews.router.ts`, composed into `app.router.ts`, with the reviews
context wired at the composition root (`apps/api/src/runtime/build-app.ts`, ADR-0005).

### Wire vocabulary

Only public identifiers cross the boundary — a slug for a catalogue row, a token for a user-owned
one (ADR-0016). No internal uuid appears in any exported type: not in an input, not in an output, not
in an error's `details`.

```ts
productSlugSchema  = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/).min(3).max(80)
skuSchema          = z.string().regex(/^[A-Z0-9][A-Z0-9-]{2,31}$/)
reviewTokenSchema  = z.string().regex(/^rev_[0-9A-Za-z]{21}$/)
userTokenSchema    = z.string().regex(/^usr_[0-9A-Za-z]{21}$/)   // exists, session/session.ts

ratingSchema       = z.number().int().min(1).max(5)
reviewTitleSchema  = z.string().trim().min(3).max(120)
reviewBodySchema   = z.string().trim().min(10).max(4000)
```

The content and identifier schemas are the same bounds as SPEC-0002's `CHECK` constraints. Two layers for one
rule, deliberately: the schema is the message a user reads, the constraint is what holds when
something writes without going through it.

```ts
ratingAggregate = {
  reviewCount:   z.number().int().nonnegative(),
  ratingAverage: z.number().min(1).max(5).nullable(),   // null ⟺ reviewCount === 0
  computedAt:    z.iso.datetime().nullable(),           // null until first computed
}

productSummary = {
  slug, sku, name, categoryName, priceMinor, currencyCode, rating: ratingAggregate,
}

productDetail = productSummary + { description }

reviewSummary = {
  token, rating, title, body,
  authorLabel: z.string(),          // never an email — SPEC-0001 open question 1
  authoredByViewer: z.boolean(),    // computed per request; drives the own-review block
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),      // differs from createdAt ⟺ edited
}

moderationReviewSummary = reviewSummary + {
  productName, productSlug,
  moderationState: z.enum(['published', 'rejected']),   // 'pending' is seeded, never returned (SPEC-0002)
}
```

`pageOf(item)` is `{ items: item[], nextCursor: string | null }`. One page shape for every list, so
the SPA has one paging component and one exhaustion test.

### The routes

| Procedure | Method + path | Session | Success |
|---|---|---|---|
| `products.list` | `GET /products` | anonymous | `pageOf(productSummary)` |
| `products.get` | `GET /products/{productSlug}` | anonymous | `productDetail` |
| `reviews.listForProduct` | `GET /products/{productSlug}/reviews` | anonymous | `pageOf(reviewSummary)` |
| `reviews.submit` | `POST /products/{productSlug}/reviews` | **required** | `reviewSummary` |
| `reviews.update` | `PATCH /reviews/{reviewToken}` | **required** | `reviewSummary` |
| `reviews.remove` | `DELETE /reviews/{reviewToken}` | **required** | `{ token }` |
| `products.create` | `POST /products` | **capability** | `productDetail` |
| `products.update` | `PATCH /products/{productSlug}` | **capability** | `productDetail` |
| `reviews.moderationList` | `GET /moderation/reviews` | **capability** | `pageOf(moderationReviewSummary)` |
| `reviews.reject` | `POST /reviews/{reviewToken}/reject` | **capability** | `reviewSummary` |
| `reviews.restore` | `POST /reviews/{reviewToken}/restore` | **capability** | `reviewSummary` |

"**capability**" means a resolved session whose user holds the capability the route needs
(`catalogue_manager` for the two `products.*` routes above, `moderator` for the three `reviews.*`
routes below — ADR-0018, and never the other one). It is a strictly stronger requirement than
"required": no session is `401`, a session without the right capability is `403`.

#### `products.list`

Input: `{ query?: string(≤80), category?: string, sort?: 'rating' | 'recent' | 'name', cursor?:
string, limit?: number.int().min(1).max(50) }`, default `limit` 20, default `sort` `'rating'`.

**A `limit` above the ceiling is rejected as `VALIDATION`, never silently capped** (TASK-0003): a
caller who asked for 500 and received 50 without being told has been lied to about the result set,
and will page as if it were complete.

`query` is a case-insensitive substring match on product **name or SKU**, so pasting a SKU finds
its product. `sort: 'rating'` orders by
`rating_average DESC NULLS LAST` then `review_count DESC` — unrated products sort last (SPEC-0001
open question 4).

**This route reads the projection** (`reviews.product_rating`, joined to `reviews.product`). That is
the entire point of ADR-0014 and should be visible in the router without a comment saying so.

#### `products.get`

Input `{ productSlug }`. Unknown slug → `NOT_FOUND`. Also reads the projection.

#### `reviews.listForProduct`

Input `{ productSlug, cursor?, limit? (≤50, default 20) }`. Newest first, keyset-paginated on
`(created_at, review_id)` — an offset would skip or repeat rows as reviews arrive under the reader.
The cursor is an opaque base64url string of that pair; it is not a page number, and a cursor from a
different sort or product is rejected as `VALIDATION`.

Only `published` reviews are returned (SPEC-0002). **This route reads the authoritative table**, not
the projection, which is why an author sees their own review immediately (ADR-0014).

`authoredByViewer` is `true` only when a session is resolved and owns the review; for an anonymous
caller every row is `false`.

#### `reviews.submit`

Input `{ productSlug, rating, title, body }`. Requires a session: an anonymous request is answered
`401` by the session middleware **before it reaches the pipeline** (TASK-0003), so an unauthenticated
caller cannot make the system do work.

- Already reviewed this product → `CONFLICT`, from the unique constraint's typed translation, never
  a raw driver error (SPEC-0002).
- Unknown product → `NOT_FOUND`.
- The write and its outbox row commit in one transaction (SPEC-0004).
- **Idempotent by deterministic id**: a retry of the same submission returns the existing review
  rather than a second row or a second event (TASK-0002).

#### `reviews.update`

Input `{ reviewToken, rating?, title?, body? }`, at least one field present or `VALIDATION`. Another
author's review → `FORBIDDEN`, and a review that does not exist → also `FORBIDDEN`, so the endpoint
is not an existence oracle. Identity and `created_at` are preserved; `updated_at` moves, which is
what the "edited" marker reads (SPEC-0001). Emits the same recomputation event a submission does.

#### `reviews.remove`

Input `{ reviewToken }`. Same ownership rule and the same event. Returns the removed token so the
client can reconcile its cache without a refetch race.

#### `reviews.moderationList`

Input `{ state?: 'published' | 'rejected', cursor?, limit? (≤50, default 20) }`, default `state`
`'published'`. Requires `moderator`. Newest-first, keyset-paginated the same way as
`reviews.listForProduct`, but **not scoped to one product and not filtered to `published` only** —
it is the one route in this contract that reads a review regardless of its moderation state, which
is exactly what a moderator needs and exactly why it is capability-gated rather than anonymous.

Output rows are `moderationReviewSummary`: `reviewSummary`'s fields plus `productName`,
`productSlug` and `moderationState`, so the moderation screen (SPEC-0001 S8) needs no second call
per row to say which product a review belongs to.

#### `reviews.reject` / `reviews.restore`

Input `{ reviewToken }`. Requires `moderator`. Both are `POST`, not `PATCH`: neither takes a body
beyond the identifier, and "reject" / "restore" are the verbs, not a field flip a client could get
backwards. Unknown token → `NOT_FOUND`. Rejecting an already-`rejected` review, or restoring an
already-`published` one, is a no-op that returns the current row rather than an error — idempotent
by the same reasoning `reviews.submit`'s deterministic id is (SPEC-0004).

Both emit the recomputation event `reviews.submit` emits, naming the review's product, because
whether a review counts toward the aggregate just changed (SPEC-0004).

#### `products.create`

Input `{ name, description, categoryName, priceMinor, currencyCode, sku, slug? }`. Requires the
`catalogue_manager` capability.

- **The slug is derived from `name` when omitted** — lowercased, non-alphanumerics collapsed to
  single hyphens, trimmed to 80 characters — and accepted verbatim when supplied, so a manager can
  fix an ugly derivation before the first save. Derivation happens server-side even though the form
  previews it (SPEC-0001 S7): a client-side slug is a suggestion, never the value.
- **A colliding slug or SKU is `CONFLICT`**, and `details` names which one (`{ field: 'slug' }` or
  `{ field: 'sku' }`) so the form can mark the right input. The collision is caught from the unique
  constraint's typed translation, not from a pre-flight `SELECT` that races.
- The response is the created `productDetail`, whose `rating` is `{ reviewCount: 0, ratingAverage:
  null, computedAt: null }` — there is no projection row yet and none is owed (SPEC-0004).
- No outbox event: nothing is derived from a product that has no reviews.

#### `products.update`

Input `{ productSlug, name?, description?, categoryName?, priceMinor?, currencyCode? }`, at least one
field present. Requires the capability.

**`slug` and `sku` are not editable, and sending either is `VALIDATION` — never a silent ignore.**
A write that accepts a field and discards it is the failure mode where a manager corrects a SKU,
sees a success toast, and finds the old value the next morning. The immutability rule itself lives
here in the pipeline, because a check constraint cannot see the old row (SPEC-0002).

### Failure

The taxonomy is `@repo/kernel`'s and the wire shape is `apiErrorShape` — `{ code, message, details? }`
where `code` is one of `ERROR_CODES`. **Status mapping happens only in
`apps/api/src/http/error-mapper.ts`**; no handler constructs a `Response` for an error case
(ADR-0008, TASK-0003). A handler's whole error contract is to throw the right typed error.

| Code | Status | Raised by |
|---|---|---|
| `VALIDATION` | 400 | Input schema, an out-of-range `limit`, an unusable cursor |
| `UNAUTHORIZED` | 401 | Write routes with no resolved session |
| `FORBIDDEN` | 403 | Editing or deleting a review the session does not own; creating or editing a product without `catalogue_manager`; moderating a review without `moderator` |
| `NOT_FOUND` | 404 | Unknown product slug; unknown review on a read |
| `CONFLICT` | 409 | The one-review-per-author constraint |
| `RATE_LIMITED` | 429 | The limiter, carrying `Retry-After` |
| `PROVIDER` / `INTERNAL` | 502 / 500 | Upstream or our own failure; body is the generic message, never ours |

`details` carries per-field validation messages and nothing else — no ids, no internal state, no
driver text. 5xx bodies are replaced with a generic message at the boundary already.

The 403-for-a-missing-review rule is asserted at the HTTP layer, not as a unit test of the guard
(TASK-0003): a guard that is correct in isolation and unwired is the failure that test would miss.

### Limits

The existing baseline (ADR-0018, `apps/api/src/http/security/rate-limit.ts`) has two buckets: `auth`
(every `/api/auth/*` request) and `unauthenticated-post` (a POST with no session), both keyed by
client IP, both answering `429` with `Retry-After`. That list is marked frozen in the source, and
TASK-0003 asks for two things it does not cover: a limit on **unauthenticated reads**, and a limit on
**review submission by an authenticated user**.

Extending a frozen security baseline is a decision, not a specification detail. This document states
the requirement and its proposed shape; the buckets are not added until a record accepts them (see
Open question 1):

- `anonymous-read` — GET with no resolved session, keyed by client IP.
- `review-submission` — `reviews.submit`, `reviews.update` and `products.create` with a session,
  keyed by the user's
  internal id (never a token in a log line, never any id in a metric attribute — the bucket name is
  the only dimension the counter carries, ADR-0009).

A rejection is the same typed `RateLimitedError` and therefore the same wire shape and `Retry-After`
header the existing buckets produce, which is what TASK-0003's header assertion tests.

### The generated document

The OpenAPI document generated from `appContract` lists every route with its inputs, outputs and
error shapes (TASK-0003). It is generated, never hand-written: a hand-written API document is a
second source of truth that starts wrong the first time a route changes.

### The session bootstrap payload

`sessionBootstrapSchema` (`packages/contracts/src/contracts/session/session.ts`) gains one field:

```ts
canManageCatalogue: z.boolean()
canModerate: z.boolean()
```

Both are **affordances, not authorizations**: the SPA renders or hides the corresponding surface
with them, and the server refuses the write regardless of what the client believes. The test that
proves the distinction calls `products.create` and, separately, `reviews.reject` with a session that
lacks the matching capability and expects `403` from each — asserted at the HTTP layer, because a
guard that is correct in isolation and unwired looks identical to one that works (ADR-0018).

Each field's name says what the client may *show*, not what the row stores (`catalogue_manager`,
`moderator`); the wording is deliberately different from the column so nobody mistakes the payload
for the source of truth.

### What the SPA does with this

`shared/api` types its client from `appContract` (already), `shared/query-keys` derives keys from
`apiQuery` (already). Invalidation rules worth stating because they are easy to get wrong:
submitting, editing or deleting a review invalidates that product's **review list** and nothing else;
the **aggregate** is left alone, because it is not updated yet (ADR-0014, SPEC-0001 rule 13).
Rejecting or restoring a review invalidates **both** the moderation list's row (S8 stays correct in
place) and, if the reviewer happens to have that product's detail screen open, its review list — the
same review-list query key `reviews.submit` already invalidates.

## Open questions

1. **The two new rate-limit buckets** need a record: ADR-0018's bucket list is stated as frozen, and
   this document deliberately does not unfreeze it. Proposal: a short record accepting
   `anonymous-read` and `review-submission` with the keys above.
2. **`authorLabel`** depends on SPEC-0001's open question 1. Until it is settled, the field is
   specified as "a stable, non-identifying label" and the derivation is not fixed here.
3. **Granting either capability has no surface.** Both are set by seed or by a database update;
   there is no admin screen for either, and ADR-0018 records that as deliberate for a system with
   one manager and one moderator. The day there are ten of either, it needs one.
4. **`reviews.listMine`** (an author's own reviews across products) is not specified: no screen in
   SPEC-0001 needs it. `ix_review__author_id` already serves it if a screen appears.
5. **Cursor stability across a sort change** is handled by rejecting a cursor that does not match the
   current sort. An alternative — encoding the sort into the cursor and ignoring the parameter — is
   friendlier and hides a client bug; rejection is proposed for that reason.

6. **Moderation actions carry no rate limit of their own.** They are capability-gated already, and a
   moderator flooding their own tool is not the threat model the anonymous-read and
   review-submission buckets exist for. Not proposed unless that assumption stops holding.

## Traceability

| Part of this specification | Constrained by | Implemented by |
|---|---|---|
| Contract-first declaration, namespaces, route paths | ADR-0004 | TASK-0003 |
| Wire vocabulary: slugs for catalogue rows, tokens for user-owned ones | ADR-0016 | TASK-0003 |
| Zod bounds mirroring the DDL checks | ADR-0004, SPEC-0002 | TASK-0002, TASK-0003 |
| Read split: list reads the projection, reviews read the truth | ADR-0014 | TASK-0003 |
| Session requirement and the pre-pipeline 401 | ADR-0018 | TASK-0003 |
| `products.create` / `products.update` and the capability gate | ADR-0018 | TASK-0008 |
| Slug derivation, slug/SKU immutability on the wire | ADR-0016 | TASK-0008 |
| `canManageCatalogue` in the bootstrap payload | ADR-0018 | TASK-0008 |
| `reviews.moderationList` / `reject` / `restore` and the capability gate | ADR-0018 | TASK-0009 |
| `canModerate` in the bootstrap payload | ADR-0018 | TASK-0009 |
| Ownership rules (403), conflict (409) | ADR-0008 | TASK-0003 |
| Error mapping in one place, generic 5xx bodies | ADR-0008 | TASK-0003 |
| Pagination bounds and cursor rules | ADR-0004 | TASK-0003 |
| Rate-limit buckets (pending a record) | ADR-0018 | TASK-0003 |
| Generated OpenAPI document | ADR-0004 | TASK-0003 |
| Client typing and invalidation rules | ADR-0012 | TASK-0004 |
