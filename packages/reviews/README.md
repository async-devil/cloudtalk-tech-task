# reviews

## Purpose

The reviews bounded context (TASK-0002, SPEC-0002): owns the product catalogue's canonical rows
(`reviews.product`), the canonical review rows (`reviews.review`), and the rating-aggregate
projection (`reviews.product_rating`) recomputed from them (ADR-0014). `submitReview` follows
ADR-0007's six-step shape end to end: a state check outside any transaction, an advisory-lock
claim, no external call (there is none to make), no write-ahead (there is no paid outcome to
record), a single commit that inserts the review and its outbox row together, and typed-failure
translation for the one collision the natural key makes possible. `createProduct`/`updateProduct`
own the catalogue's write path and guard its immutable identity fields (`slug`, `sku`);
`recomputeProductRating`/`rebuildProductRating` are this context's only writers of
`reviews.product_rating`, and the projection can be dropped and rebuilt from the authoritative
review rows at any time (ADR-0014).

**When NOT to use this.** This package owns product/review DOMAIN WRITES and the rating
projection's write path only. It is not an HTTP surface — request parsing, session/auth, and the
wire-shape mapping of these types are TASK-0003's. It is not the aggregation worker — the
scheduled outbox relay that calls `recomputeProductRating` on a cadence, and its own span/counter/
histogram, are TASK-0005's; nothing in this package schedules anything. It is not a moderation
decision engine — storing `review_moderation_state_id` is in scope, but deciding when a review
moves between `published` and `rejected` is a separate write path this package does not implement
(TASK-0009). And it is not a read path: every exported function here writes (`recomputeProductRating`/
`rebuildProductRating` write the projection even though they look read-shaped) — a screen that only
needs to list or display `reviews.product`/`reviews.review` rows has no reason to route through
this package rather than querying them directly at its own boundary.

## Public contract

```ts
createProduct(db: Kysely<unknown>, input: CreateProductInput): Promise<ProductRecord>;
updateProduct(db: Kysely<unknown>, input: UpdateProductInput): Promise<ProductRecord>;

submitReview(db: Kysely<unknown>, input: SubmitReviewInput): Promise<SubmitReviewResult>;

recomputeProductRating(db: Kysely<unknown>, productId: string): Promise<ProductRatingRecord>;
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
ratingAverage: string | null, computedAt }`. No exported record type carries an internal uuid
(ADR-0016) — `slug` and `token` are the only identifiers that cross this module's contract.

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
| `@repo/observability` | `createModuleObservability` — the one facade this module's four spans go through (ADR-0009). |
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

Container-proved (TASK-0002's acceptance criteria; `test-integration/`, written against this
package's `vitest.integration.config.ts` by the engineer following this one — not present in this
change):

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

## Telemetry

Source records: [ADR-0009](../../docs/adr/ADR-0009-observability-through-a-facade.md) and
[TASK-0002](../../docs/tasks/TASK-0002-reviews-bounded-context.md).

<!-- Every emitted span maps to a line here; the telemetry-map gate enforces both directions. -->

**Spans:**

- `reviews.review.submit` — attributes `outcome` (`created` | `replayed`), `productSlug`,
  `reviewToken`.
- `reviews.product.create`
- `reviews.product.update`
- `reviews.rating.rebuild`

**Instruments:** none. SPEC-0004 names two — a counter and a histogram, reviews.rating.recompute
and reviews.rating.lag (named here in plain prose, without backticks, on purpose: this package
emits neither of them, and the telemetry-map gate fails a README line that backtick-names
something the module does not emit) — and assigns both to TASK-0005's outbox relay, not to this
package. Created-vs-replayed is a per-request fact that belongs on this module's own span
attribute, not on a metric, under ADR-0009's cardinality budget. Both instruments arrive with the
worker in TASK-0005.

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
3. `tsc` build and `vitest run` must pass standalone; the Testcontainers `postgres:18` suite
   (`vitest run --config vitest.integration.config.ts`) additionally needs Docker.
