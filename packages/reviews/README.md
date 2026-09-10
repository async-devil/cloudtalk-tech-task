# reviews

## Purpose

The reviews bounded context (TASK-0002, TASK-0003, SPEC-0002, SPEC-0003): owns the product
catalogue's canonical rows (`reviews.product`), the canonical review rows (`reviews.review`), and
the rating-aggregate projection (`reviews.product_rating`) recomputed from them (ADR-0014), for
both writes and reads. `submitReview` follows ADR-0007's six-step shape end to end: a state check
outside any transaction, an advisory-lock claim, no external call (there is none to make), no
write-ahead (there is no paid outcome to record), a single commit that inserts the review and its
outbox row together, and typed-failure translation for the one collision the natural key makes
possible. `updateReview`/`removeReview` follow the same shape, shorter (no replay/conflict branch
to decide), and end in the same `rating.recompute` outbox row `submitReview` emits (SPEC-0004).
`createProduct`/`updateProduct` own the catalogue's write path and guard its immutable identity
fields (`slug`, `sku`); `recomputeProductRating`/`rebuildProductRating` are this context's only
writers of `reviews.product_rating`, and the projection can be dropped and rebuilt from the
authoritative review rows at any time (ADR-0014). `listProducts`/`getProductBySlug` read that same
projection; `listReviewsForProduct` reads the authoritative `reviews.review` table directly — the
read split TASK-0003 asks this package to make visible in its own `FROM`/`JOIN` clauses, with no
comment needed to say so, and exactly why an author sees their own review immediately while the
average may still show its previous value (ADR-0014, SPEC-0001 rules 8 and 13).

**When NOT to use this.** This package owns product/review domain reads AND writes and the rating
projection's write path — it is not an HTTP surface: request parsing, session/auth resolution,
rate limiting, and the wire-shape mapping of every type here (including converting `authorId` to
`authorLabel`/`authoredByViewer` and `ratingAverage`/`computedAt` to their wire shapes) are
TASK-0003's router, `apps/api/src/routes/{products,reviews}/`. It is not the aggregation worker —
the scheduled outbox relay that calls `recomputeProductRating` on a cadence, and its own span/
counter/histogram, are TASK-0005's; nothing in this package schedules anything. It is not a
moderation decision engine — storing `review_moderation_state_id` is in scope, but deciding when a
review moves between `published` and `rejected`, and the moderation-scoped list that reads
regardless of state, are a separate write/read path this package does not implement (TASK-0009).
And it is not where an author's identity becomes a display label — `authorLabel`'s derivation from
`auth.identity.email` lives in `@repo/auth` (`authorLabelsForUserIds`), because this package has no
sanctioned edge to the `auth` schema (ADR-0001); `listReviewsForProduct` hands back the author's
internal id for exactly that reason (see `ReviewListItem`'s own doc).

## Public contract

```ts
createProduct(db: Kysely<unknown>, input: CreateProductInput): Promise<ProductRecord>;
updateProduct(db: Kysely<unknown>, input: UpdateProductInput): Promise<ProductRecord>;
listProducts(db: Kysely<unknown>, input: ListProductsInput): Promise<ProductListPage>;
getProductBySlug(db: Kysely<unknown>, productSlug: string): Promise<ProductDetailRecord>;

submitReview(db: Kysely<unknown>, input: SubmitReviewInput): Promise<SubmitReviewResult>;
updateReview(db: Kysely<unknown>, input: UpdateReviewInput): Promise<ReviewMutationRecord>;
removeReview(db: Kysely<unknown>, input: RemoveReviewInput): Promise<void>;
listReviewsForProduct(
  db: Kysely<unknown>,
  input: ListReviewsForProductInput,
): Promise<ReviewListPage>;

recomputeProductRating(
  db: Kysely<unknown>,
  productId: string,
  options?: RecomputeProductRatingOptions,   // { outboxRowCreatedAt?: Date } — lag input only
): Promise<ProductRatingRecord>;
rebuildProductRating(
  db: Kysely<unknown>,
  options?: RebuildProductRatingOptions,
): Promise<RebuildProductRatingReport>;

REVIEWS_OUTBOX: OutboxTableRef;       // { schema: 'reviews', table: 'outbox' }
RATING_RECOMPUTE_OP: 'rating.recompute';
```

`ProductRecord { slug, sku, name, description, categoryName, priceMinor, currencyCode, createdAt,
updatedAt }`; `ReviewRecord { token, productSlug, rating, title, body, moderationState, createdAt,
updatedAt }`; `SubmitReviewResult { review, replayed }`; `ProductRatingRecord { reviewCount,
ratingAverage: string | null, computedAt }`.

`ProductSummaryRecord { slug, sku, name, categoryName, priceMinor, currencyCode, rating:
ProductRatingSummary }`; `ProductDetailRecord` extends it with `description`;
`ProductRatingSummary { reviewCount, ratingAverage: string | null, computedAt: Date | null }` —
`computedAt` is `null` until a product's first recomputation ever runs. `ProductListPage { items:
ProductSummaryRecord[], nextCursor: string | null }`; `ListProductsInput { query?, category?,
sort: 'rating' | 'recent' | 'name', cursor?, limit }`.

`ReviewListItem { token, rating, title, body, authorId, createdAt, updatedAt }` — **`authorId` is
the one deliberate, narrow exception to "no internal uuid crosses this module's public contract"**;
see the type's own TSDoc (`src/reviews.ts`) for the full reasoning (this package has no sanctioned
edge to `@repo/auth`, so the composition root is the only place `authorId` can become
`authoredByViewer`/`authorLabel`, which means this module has to hand it back). `ReviewListPage
{ items: ReviewListItem[], nextCursor: string | null }`; `ListReviewsForProductInput { productSlug,
cursor?, limit }`. `ReviewMutationRecord { token, rating, title, body, createdAt, updatedAt }` —
`updateReview`'s result, deliberately without `moderationState` (an edit never touches it) or
`productSlug` (no exported wire shape needs it back).

No OTHER exported record type carries an internal uuid (ADR-0016) — `slug` and `token` are the
only identifiers that cross this module's contract everywhere but `ReviewListItem.authorId`.

Every `db` parameter is `Kysely<unknown>`: there is no generated DB type in this repository, so
every query here is the `sql` tagged template plus a parsed row schema (ADR-0004).

**`ratingAverage` stays `string | null` all the way out, on purpose.** `rating_average` is
`numeric(3,2)` and the Postgres driver returns a `numeric` column as a string, never a number.
Converting it here would reintroduce the rounding argument `numeric` exists to end, and TASK-0002's
idempotence and drop-and-rebuild proofs depend on comparing it exactly — a converted-then-reformatted
float is not guaranteed to compare equal to itself across two recomputations. TASK-0003 is where a
number is ever produced, at the wire. Do not "fix" this in a later change without a record that
overturns SPEC-0002's rule.

## Dependencies

| Dependency | Reason |
|---|---|
| `kysely@0.29.3` | The `sql` tagged template and the `Kysely<unknown>` handle every function here takes as its first argument. This module owns no generated DB type (ADR-0004). |
| `zod@4.4.3` | The row-schema parse boundary (`internal/rows.ts`) every raw SQL row passes through via `rowAs`/`rowsAs` (ADR-0004). |
| `@repo/entities` | `PRODUCT_CATEGORY`/`REVIEW_MODERATION_STATE` (the two reference vocabularies this module resolves ids against) and `TOKEN_PREFIX`/`mintToken` (a submitted review's `rev_…` token). |
| `@repo/jobs` | `insertOutboxRows`/`OutboxTableRef` — the sanctioned Tier-2 edge (`tools/arch-checks/src/module-registry.cjs`): the outbox producer must run inside the domain write's own transaction (ADR-0007 step 6), so it cannot be lifted to a composition root. |
| `@repo/kernel` | The typed error taxonomy — `ConflictError`, `NotFoundError`, `ValidationError`, `InternalError` (ADR-0008). |
| `@repo/observability` | `createModuleObservability`/`METRIC_ATTRIBUTE` — the one facade this module's four spans and two instruments (`recomputeProductRating`'s counter and histogram, TASK-0005) go through (ADR-0009). |
| `@repo/persistence` | `rowAs`/`rowsAs` — the sanctioned Tier-2 edge, the same reason `jobs` and `auth` have it: every row this module reads comes back through a parse boundary, never a cast (ADR-0004). |

Deliberately absent: `pg` (a provider SDK; concrete adapters live only in `apps/*/src/runtime/**`
per ADR-0005, and this module receives its Postgres handle already connected — importing `pg`
here would also break the extraction proof, see `internal/unique-violation.ts`'s doc comment).
`@repo/messaging` (this module never enqueues a BullMQ job directly; the outbox is the only
cross-process fan-out point, and `@repo/jobs`'s relay is what turns an outbox row into work in
TASK-0005). `@repo/config` (this module reads no `process.env` value at all — see Config slice).

## Config slice

None. This module takes its Postgres handle as an injected `Kysely<unknown>` from its caller —
the composition root owns connecting it; this module owns only what to do with it — and reads no
`process.env` value directly, which is `@repo/config`'s rule to enforce, not something this
module needs a slice to declare. `packages/jobs`, this package's shape reference, takes the same
position and — unlike every other module in this tree — omits a `## Config slice` heading
entirely rather than write "None"; this README keeps the heading, because CONTRIBUTING's
module-README contract asks every module for one, and states explicitly what `jobs` leaves
implicit.

## Named invariants

<!-- Every invariant maps to a test id (ADR-0010.4). -->

Unit-proved now, against no database:

- **INV-1** — A Postgres unique-violation (SQLSTATE `23505`) always becomes a typed `AppError`,
  never a raw driver error: `uq_product__slug`/`uq_product__sku`/`uq_review__product_id__author_id`
  become `ConflictError` with the matching `details.field`; any other `23505` (`uq_review__token`
  included) becomes `InternalError`; anything that is not a `23505` at all is left untranslated.
  Never by `instanceof` on a `pg` class and never by matching `error.message` (ADR-0008). Test:
  `test/unique-violation.test.ts`.
- **INV-2** — `reviews.product.slug` and `.sku` cannot be changed after creation:
  `productUpdateBindsFor` throws `ValidationError` when the wire-shape input carries either key at
  runtime — checked with `'slug' in input`/`'sku' in input`, not just the type, because a JSON
  body from TASK-0003's HTTP boundary still carries the key at runtime even though
  `UpdateProductInput`'s type does not declare it. The same function also rejects a patch with no
  mutable field at all (SPEC-0002). Test: `test/immutable-fields.test.ts`.
- **INV-3** — This module's compile-time reference-id lookups (`productCategoryIdFor`/
  `productCategoryNameFor`/`reviewModerationStateNameFor`) agree with SPEC-0002's literal seeded
  ids exactly, pinned against those literals rather than against `PRODUCT_CATEGORY`/
  `REVIEW_MODERATION_STATE` themselves — a renumbering of either vocabulary breaks this test
  structurally instead of leaving it green by construction. Test: `test/reference-ids.test.ts`.
- **INV-12** — `encodeCursor`/`decodeCursor` round-trip a payload unchanged, the encoded form is
  opaque (never contains the payload's own substrings) and is genuinely base64url (never `+`, `/`
  or `=`), and anything that fails to decode — malformed base64, malformed JSON, or JSON that
  fails the caller's schema — is a `ValidationError({ field: 'cursor' })`, never a raw exception.
  Test: `test/cursor.test.ts`.

Container-proved (`test-integration/`, written against this package's
`vitest.integration.config.ts` — TASK-0002's acceptance criteria proved by the engineer preceding
this one, TASK-0005's by this change):

- **INV-4** — Submitting a review writes the review row and its outbox row in the SAME
  transaction: no committed review is ever missing its scheduled recomputation (ADR-0007 step 5,
  SPEC-0004).
- **INV-5** — Replaying `submitReview` with the same `(productSlug, authorId)` and identical
  content is a no-op that returns the existing review and emits no second outbox row; differing
  content is a `ConflictError` (ADR-0007's idempotent replay by natural key).
- **INV-6** — `rebuildProductRating` is idempotent (running it twice yields byte-identical rows
  apart from `computed_at`) and, after dropping `reviews.product_rating` entirely, reconstructs it
  to match a recomputation from the authoritative `reviews.review` rows (ADR-0014).
- The DB-side half of INV-3's parity claim — that `PRODUCT_CATEGORY`/`REVIEW_MODERATION_STATE` and
  the seeded `reference.*` rows are one thing, not merely that this module's own lookups agree
  with themselves — is `test-integration/reference-parity.test.ts`, already named by SPEC-0002.
- **INV-7** — Replaying a delivered outbox row (redelivered via a status flip back to `Pending`,
  the honest simulation of at-least-once delivery) leaves `product_rating` identical apart from a
  strictly-later `computed_at` (SPEC-0004, TASK-0005). Test:
  `test-integration/outbox-relay-durability.test.ts`.
- **INV-8** — Killing the relay process mid-recompute (a real `SIGKILL` against a real `bun`
  process, not a mocked rejection) and restarting it converges `product_rating` to the value an
  independent aggregate over `reviews.review` gives, regardless of what the killed attempt did or
  did not durably write — the property ADR-0007's machinery exists to buy (TASK-0005's Notes). Test:
  `test-integration/outbox-relay-durability.test.ts`.
- **INV-9** — Flushing Redis entirely loses no work: the pending outbox row survives in Postgres
  untouched, and re-registering the repeatable schedule against the flushed Redis (what the
  composition root does on every boot) drains it (SPEC-0004). Test:
  `test-integration/outbox-relay-durability.test.ts`.
- **INV-10** — A row whose `apply` always throws parks `dead` after exactly `maxAttempts` and is
  never retried again (ADR-0007). Test: `test-integration/outbox-relay-durability.test.ts` — this
  test does NOT prove the `jobs.dead_letter` triage write SPEC-0004 also describes for a parked
  row; that half is implemented and proved separately, at the API composition root
  (`apps/api/src/runtime/reviews-rating-worker.ts`), which this package cannot depend on (ADR-0001
  tier order) and therefore cannot exercise from here — see that file's own doc comment.
- **INV-11** — `reviews.rating.lag` records a value for every outbox row a relay pass applies
  (measured, not assumed — SPEC-0004), and both `reviews.rating.recompute` and `reviews.rating.lag`
  carry only `outcome` (SPEC-0004, ADR-0009 cardinality budget). Test:
  `test-integration/outbox-relay-durability.test.ts`.
- **INV-13** — `listProducts`/`getProductBySlug` read the rating PROJECTION only, never
  `reviews.review` directly: a submitted-but-never-recomputed review leaves its product's aggregate
  reading `{ reviewCount: 0, ratingAverage: null, computedAt: null }` (ADR-0014). Test:
  `test-integration/product-list.test.ts`.
- **INV-14** — `listProducts` keyset-paginates each of its three sorts (`'rating'` unrated-last,
  `'recent'`, `'name'`) with no skip or repeat across pages, and rejects a cursor minted under a
  different sort as `VALIDATION` (SPEC-0003 open question 5). Test:
  `test-integration/product-list.test.ts`.
- **INV-15** — `listReviewsForProduct` reads the AUTHORITATIVE table: a freshly submitted review is
  visible immediately, with no recomputation run (ADR-0014); a rejected review is excluded
  (SPEC-0001 rule 11); pagination is keyset on `(created_at, token)` with no skip or repeat; and a
  cursor minted for a different product is rejected as `VALIDATION`. Test:
  `test-integration/review-list-and-mutations.test.ts`.
- **INV-16** — `updateReview`/`removeReview`: editing or deleting another author's review, and
  editing or deleting a token that does not exist, all throw the IDENTICAL `ForbiddenError` (same
  message, same `details`) — never `NotFoundError`, so neither route is an existence oracle
  (SPEC-0001 rule 5). An edit preserves `createdAt`, moves `updatedAt`, and — like a deletion —
  emits the same `rating.recompute` outbox row a submission does (SPEC-0004). Test:
  `test-integration/review-list-and-mutations.test.ts`.

## Telemetry

Source records: [ADR-0009](../../docs/adr/ADR-0009-observability-through-a-facade.md),
[TASK-0002](../../docs/tasks/TASK-0002-reviews-bounded-context.md),
[TASK-0003](../../docs/tasks/TASK-0003-products-and-reviews-api.md) and
[TASK-0005](../../docs/tasks/TASK-0005-rating-aggregation-worker.md).

<!-- Every emitted span and instrument maps to a line here; the telemetry-map gate enforces both
     directions. -->

**Spans:**

- `reviews.review.submit` — attributes `outcome` (`created` | `replayed`), `productSlug`,
  `reviewToken`.
- `reviews.review.update` (TASK-0003)
- `reviews.review.remove` (TASK-0003)
- `reviews.review.list` (TASK-0003) — `listReviewsForProduct`.
- `reviews.product.create`
- `reviews.product.update`
- `reviews.product.list` (TASK-0003)
- `reviews.product.get` (TASK-0003)
- `reviews.rating.rebuild`
- `reviews.rating.recompute` — attribute `productId` (an internal uuid; ids belong on spans, never
  on a metric — ADR-0009 cardinality budget). Opened by every `recomputeProductRating` call,
  whether the caller is the outbox relay's `apply` (TASK-0005, wired at `apps/api/src/runtime/`)
  or `rebuildProductRating` recomputing one product at a time.

**Instruments:**

- `reviews.rating.recompute` — counter, attribute `outcome` (`success` | `error`). One `add` per
  `recomputeProductRating` call, whichever way it settles; SPEC-0004's aggregation-lag pair.
- `reviews.rating.lag` — histogram, unit `ms`, attribute `outcome` (`success` always — see below).
  Ms from the delivering outbox row's `created_at` to the moment this recomputation's `computed_at`
  commits (SPEC-0004): the number that answers "how stale can the average on the product page be",
  measured rather than assumed. Recorded ONLY when the caller passes
  `RecomputeProductRatingOptions.outboxRowCreatedAt` — the outbox relay's `apply` always does;
  `rebuildProductRating` never does, because a rebuild has no outbox row and fabricating a lag
  value (e.g. `0`) for it would misreport staleness rather than honestly recording none.

Created-vs-replayed (`reviews.review.submit`'s own `outcome` attribute) stays a span attribute,
not a metric, under ADR-0009's cardinality budget — the same reasoning that keeps a `productSlug`
off `reviews.rating.recompute`'s counter.

No `failSpan` and no `logger.error`/`logger.fatal`/`console.*` anywhere in this module: every
pipeline here throws a typed error and handles nothing itself (ADR-0008) — the boundaries that
handle are the HTTP error mapper (TASK-0003) and the outbox relay (TASK-0005). Calling `failSpan`
in this module would be catch-log-rethrow and would double-fire the error triple on every
propagation hop.

## Extraction steps

Tier-capability, liftable: depends on `kysely`/`zod` and the liftable workspace modules listed
above (`@repo/entities`, `@repo/jobs`, `@repo/kernel`, `@repo/observability`, `@repo/persistence` —
all liftable themselves). No `pg` import anywhere in `src/` — Postgres arrives as an injected
`Kysely<unknown>` handle from the composition root, so this package carries no provider-specific
runtime coupling to lift.

1. Copy `packages/reviews/` to the target repository.
2. Vendor or re-add its five workspace deps and `bun install`.
3. `tsc` build and `vitest run` must pass standalone; the Testcontainers suite
   (`vitest run --config vitest.integration.config.ts`) additionally needs Docker and now starts
   BOTH `postgres:18` and `redis:8-alpine` (TASK-0005's outbox-relay durability proofs need a real
   BullMQ-backed relay, not just Postgres) — `@opentelemetry/api` is a devDependency for the same
   suite's live-meter assertion (`reviews.rating.lag` records a value), not a runtime dependency of
   `src/`.
