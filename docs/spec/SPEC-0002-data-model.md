---
id: SPEC-0002
title: The data model — the reviews schema, its vocabularies and its projection
status: draft
supersedes: []
adr: [ADR-0006, ADR-0014, ADR-0016, ADR-0018]
date: 2026-09-09
---

## Context

TASK-0002 requires four tables — `product`, `review`, the moderation-state vocabulary and
`product_rating` — and states acceptance criteria for them without defining a single column. This
document defines them: every column, type, constraint and index, in a shape that satisfies ADR-0016's
conventions as the `migration-ddl` gate actually enforces them, so the migration is a transcription
rather than a design exercise.

What exists already and is not restated: the `persistence` and `reference` schemas and the
`persistence.set_updated_at()` trigger function (`0001-create-persistence-bootstrap.ts`), the jobs
spine and its four vocabularies (`0002-create-jobs-spine.ts`), and the `auth` schema including
`auth.app_user`, the app-owned user record every domain table references
(`0003-create-auth.ts`).

## Specification

### Schema and ownership

One schema per bounded context (ADR-0016). The `reviews` module owns schema `reviews`; its closed
vocabularies live in `reference`, which belongs to no single module, alongside the spine's four. No
other module reads these tables — a cross-module read is a typed port or an event (ADR-0001).

Three migration files, all on the single global index sequence (ADR-0006: one folder, one
sequence, so cross-module ordering is not a matter of luck), hand-written, append-only, immutable
once merged:

- **`0004-create-reviews.ts`** — everything below.
- **`0005-add-app-user-catalogue-manager.ts`** — one statement:
  `ALTER TABLE auth.app_user ADD COLUMN catalogue_manager boolean NOT NULL DEFAULT false`. It is a
  separate file rather than an edit to `0003-create-auth.ts` because a merged migration is
  immutable, and it belongs to the `auth` schema rather than to `reviews` because the capability is
  a property of the user, not of the catalogue (ADR-0018). `NOT NULL DEFAULT false`: the
  `nullable-boolean` rule forbids the third state, and "unknown" is not a capability anyone holds.
- **`0006-add-app-user-moderator.ts`** — the same shape, one statement:
  `ALTER TABLE auth.app_user ADD COLUMN moderator boolean NOT NULL DEFAULT false`. A separate file
  from `0005` for the same reason `0005` is separate from `0003`: each capability is its own
  reviewed change (ADR-0018), and a migration that added two columns for two unrelated grants would
  read as one decision when it is two.

### `reference.product_category`

A closed vocabulary, not a `CHECK` and not a native enum: a new category is an insert, and the table
can be joined for a display label (ADR-0016).

```sql
CREATE TABLE reference.product_category (
  product_category_id integer NOT NULL,
  name                text    NOT NULL,
  CONSTRAINT pk_product_category PRIMARY KEY (product_category_id),
  CONSTRAINT uq_product_category__name UNIQUE (name)
)
```

Seeded in the migration from `PRODUCT_CATEGORY` in `@repo/entities` and parity-tested, exactly like
`reference.stage_status`. Ids are the contract and are never renumbered. Initial values:
`(1, 'audio')`, `(2, 'computing')`, `(3, 'home')`, `(4, 'outdoor')`, `(5, 'kitchen')`.

### `reference.review_moderation_state`

```sql
CREATE TABLE reference.review_moderation_state (
  review_moderation_state_id integer NOT NULL,
  name                       text    NOT NULL,
  CONSTRAINT pk_review_moderation_state PRIMARY KEY (review_moderation_state_id),
  CONSTRAINT uq_review_moderation_state__name UNIQUE (name)
)
```

Values: `(1, 'published')`, `(2, 'pending')`, `(3, 'rejected')`. Every review is created
`published`. A moderator (ADR-0018) may transition a review between `published` and `rejected`;
`pending` remains seeded and unused — reserved for a future reporting flow, not written by anything
in v1. The transition is a plain `UPDATE` of `review_moderation_state_id`, the same statement whether
moving forward or back, so "reject" and "restore" are one code path reading two different target
ids rather than two.

### `reviews.product`

```sql
CREATE TABLE reviews.product (
  product_id          uuid        NOT NULL DEFAULT uuidv7(),
  slug                text        NOT NULL,
  sku                 text        NOT NULL,
  name                text        NOT NULL,
  description         text        NOT NULL,
  product_category_id integer     NOT NULL,
  price_minor         integer     NOT NULL,
  currency_code       text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_product PRIMARY KEY (product_id),
  CONSTRAINT uq_product__slug UNIQUE (slug),
  CONSTRAINT uq_product__sku UNIQUE (sku),
  CONSTRAINT ck_product__slug_format CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  CONSTRAINT ck_product__slug_length CHECK (char_length(slug) BETWEEN 3 AND 80),
  CONSTRAINT ck_product__sku_format CHECK (sku ~ '^[A-Z0-9][A-Z0-9-]{2,31}$'),
  CONSTRAINT ck_product__name_not_empty CHECK (name <> ''),
  CONSTRAINT ck_product__price_minor_non_negative CHECK (price_minor >= 0),
  CONSTRAINT ck_product__currency_code_iso CHECK (currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT fk_product__product_category FOREIGN KEY (product_category_id)
    REFERENCES reference.product_category (product_category_id)
)
CREATE TRIGGER tg_product__set_updated_at
  BEFORE UPDATE ON reviews.product
  FOR EACH ROW EXECUTE FUNCTION persistence.set_updated_at()
CREATE INDEX ix_product__product_category_id ON reviews.product (product_category_id)
```

- **`slug` is the product's public identifier** — the API path segment and the SPA route key
  (ADR-0016). A catalogue is enumerable by construction, so an opaque token would protect nothing
  the catalogue screen does not hand out anyway, while costing readability on every link and support
  ticket. Reviews and users keep their `rev_`/`usr_` tokens: those are user-owned rows, where
  walking the id space reads someone else's data. `product_id` still never crosses the wire.
- **`sku` is a business identifier, not an address.** Unique, uppercase, and stored in its own
  column so the catalogue and a warehouse can say the same word. It is never a path segment: a SKU
  that becomes a URL is a SKU that can never be corrected.
- **Both are immutable after creation, and neither immutability can be a constraint.** A check
  constraint cannot see the old row, so the rule lives in the write pipeline (SPEC-0003:
  `products.update` rejects either field) and is worth exactly as much as the test that proves it —
  mutate the guard, watch the test go red, restore it (ADR-0010).
- `uq_product__slug` is also the index the by-slug read uses; there is no separate `ix_`.
- `price_minor` is minor units in an integer, never a float (ADR-0016), with `currency_code` beside
  it because an amount without its currency is not an amount.
- The category index is added with the query that needs it: the catalogue's category filter
  (SPEC-0003, `products.list`).
- Products are created in the application by a catalogue manager (SPEC-0001 screen S7, SPEC-0003
  `products.create`) and seeded for a fresh checkout (TASK-0006). Both paths write the same row
  through the same pipeline.

### `reviews.review`

```sql
CREATE TABLE reviews.review (
  review_id                  uuid        NOT NULL DEFAULT uuidv7(),
  token                      text        NOT NULL,
  product_id                 uuid        NOT NULL,
  author_id                  uuid        NOT NULL,
  rating                     smallint    NOT NULL,
  title                      text        NOT NULL,
  body                       text        NOT NULL,
  review_moderation_state_id integer     NOT NULL,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_review PRIMARY KEY (review_id),
  CONSTRAINT uq_review__token UNIQUE (token),
  CONSTRAINT uq_review__product_id__author_id UNIQUE (product_id, author_id),
  CONSTRAINT ck_review__token_format CHECK (token ~ '^rev_[0-9A-Za-z]{21}$'),
  CONSTRAINT ck_review__rating_range CHECK (rating BETWEEN 1 AND 5),
  CONSTRAINT ck_review__title_length CHECK (char_length(title) BETWEEN 3 AND 120),
  CONSTRAINT ck_review__body_length CHECK (char_length(body) BETWEEN 10 AND 4000),
  CONSTRAINT fk_review__product FOREIGN KEY (product_id)
    REFERENCES reviews.product (product_id) ON DELETE CASCADE,
  CONSTRAINT fk_review__author FOREIGN KEY (author_id)
    REFERENCES auth.app_user (app_user_id) ON DELETE CASCADE,
  CONSTRAINT fk_review__review_moderation_state FOREIGN KEY (review_moderation_state_id)
    REFERENCES reference.review_moderation_state (review_moderation_state_id)
)
CREATE TRIGGER tg_review__set_updated_at
  BEFORE UPDATE ON reviews.review
  FOR EACH ROW EXECUTE FUNCTION persistence.set_updated_at()
CREATE INDEX ix_review__product_id__created_at ON reviews.review (product_id, created_at DESC)
CREATE INDEX ix_review__author_id ON reviews.review (author_id)
```

- **`uq_review__product_id__author_id` is the one-review-per-author rule** (SPEC-0001 rule 2). It is
  the database's, not the application's: the pipeline catches the unique violation and raises a typed
  `ConflictError` (ADR-0008), and a raw driver error never escapes (TASK-0002's criterion).
- **`author_id` references `auth.app_user.app_user_id`** — the app-owned record, never
  `auth.identity.id`. That cross-schema reference is the one the auth migration's header sanctions,
  and it is what keeps better-auth swappable.
- **`ON DELETE CASCADE` on both foreign keys** is deliberate: deleting a product deletes its reviews,
  and user erasure cascades from `auth.identity` through `auth.app_user` to here. Neither leaves the
  projection correct on its own — see the erasure note under Open questions.
- **The length checks duplicate the Zod schemas** (SPEC-0003) on purpose: the schema is the message a
  user reads, the constraint is what holds when something writes without going through it.
- `ix_review__product_id__created_at` serves the product review list's keyset pagination
  (SPEC-0003); `ix_review__author_id` serves the own-review lookup on product detail and makes the
  erasure cascade cheap.

### `reviews.product_rating` — the projection

```sql
CREATE TABLE reviews.product_rating (
  product_id     uuid        NOT NULL,
  review_count   integer     NOT NULL,
  rating_average numeric(3,2),
  computed_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT pk_product_rating PRIMARY KEY (product_id),
  CONSTRAINT ck_product_rating__review_count_non_negative CHECK (review_count >= 0),
  CONSTRAINT ck_product_rating__rating_average_range
    CHECK (rating_average IS NULL OR rating_average BETWEEN 1 AND 5),
  CONSTRAINT ck_product_rating__average_present_when_reviewed
    CHECK ((review_count = 0) = (rating_average IS NULL)),
  CONSTRAINT fk_product_rating__product FOREIGN KEY (product_id)
    REFERENCES reviews.product (product_id) ON DELETE CASCADE
)
```

- **Keyed by `product_id`, not a `product_rating_id`.** ADR-0016's `<table>_id` rule exists to make
  foreign-key columns self-describing; a projection keyed one-to-one by its subject has nothing to
  describe. The `migration-ddl` gate already exempts tables the lifecycle registry classes as
  `projection` — the exemption is scoped by class, not by name, so this needs no gate edit.
- **`rating_average` is the only nullable column in this schema**, and the third check makes "no
  reviews" and "no average" the same fact rather than two that can disagree. SPEC-0001 rule 8 renders
  it as "No reviews yet", never `0.0`.
- **A product may have no row here at all.** The projection row appears when the first
  recomputation runs, which is after the first review — so a newly created product has none, and
  every read joins `LEFT`. Do not paper over the null with a zero-row insert at creation time: an
  aggregate row claiming `computed_at` for a computation that never happened is a lie the UI would
  faithfully display.
- **No `updated_at`, and no trigger.** `computed_at` is not a row-modification timestamp; it is the
  claim the UI displays ("calculated 2 minutes ago") and the worker sets it explicitly on every
  recomputation, including one that finds nothing changed.
- `numeric(3,2)` holds `1.00`–`5.00` exactly. A float average of integers is a rounding argument
  nobody needs to have.
- **The table may be dropped and rebuilt at any time** (ADR-0014). TASK-0002 proves it: drop, rebuild,
  compare against a recomputation from the authoritative rows.

### `reviews.outbox`

Each bounded context owns its own outbox table, and `@repo/jobs` takes it as an `OutboxTableRef`
(`{ schema, table }`) rather than string-building a name. The shape is the spine's, not this
context's — the relay's claim, mark and park statements read exactly these columns (ADR-0007), so it
is transcribed, not designed:

```sql
CREATE TABLE reviews.outbox (
  outbox_id            bigserial   NOT NULL,
  aggregate_id         text        NOT NULL,
  op                   text        NOT NULL,
  payload              jsonb       NOT NULL,
  attempts             integer     NOT NULL DEFAULT 0,
  last_error           text,
  outbox_row_status_id integer     NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  processed_at         timestamptz,
  CONSTRAINT pk_outbox PRIMARY KEY (outbox_id),
  CONSTRAINT ck_outbox__attempts_non_negative CHECK (attempts >= 0),
  CONSTRAINT fk_outbox__outbox_row_status FOREIGN KEY (outbox_row_status_id)
    REFERENCES reference.outbox_row_status (outbox_row_status_id)
)
CREATE INDEX ix_outbox__outbox_row_status_id__outbox_id
  ON reviews.outbox (outbox_row_status_id, outbox_id)
```

The index serves the relay's claim (`WHERE outbox_row_status_id = 1 ORDER BY outbox_id FOR UPDATE
SKIP LOCKED`) — added with the query that needs it. What rows it carries and who writes them is
SPEC-0004.

### Vocabularies in `@repo/entities`

Two new declarations, in the shape of the existing `jobs/stage-status.entity.ts` — a const value set,
the derived id/name types, and a row schema — exported from the single barrel:

| File | Exports |
|---|---|
| `src/reviews/product-category.entity.ts` | `PRODUCT_CATEGORY`, `ProductCategoryId`, `ProductCategoryName`, `ProductCategoryRow`, `productCategoryRowSchema` |
| `src/reviews/review-moderation-state.entity.ts` | `REVIEW_MODERATION_STATE`, `ReviewModerationStateId`, `ReviewModerationStateName`, `ReviewModerationStateRow`, `reviewModerationStateRowSchema` |

Each is parity-tested against the seeded rows, like the spine's four: the vocabulary in code and the
vocabulary in the database are one thing, and the test is what keeps them one thing.

`TOKEN_PREFIX` already carries `Product`, `Review` and `User` with the right comments — no change.

### Data-lifecycle registry

Every `CREATE TABLE` must have a row in `tools/arch-checks/src/data-lifecycle-registry.cjs` or the
`migration-ddl` gate fails the migration (ADR-0006). The four rows this schema adds:

| `schema.table` | Class | Why |
|---|---|---|
| `reference.product_category` | `reference` | Seeded vocabulary, permanent, parity-tested |
| `reference.review_moderation_state` | `reference` | Same |
| `reviews.product` | `truth` | Canonical catalogue rows |
| `reviews.review` | `truth` | Canonical domain rows; die by domain action (deletion, erasure cascade) |
| `reviews.product_rating` | `projection` | Rebuildable read model, maintained by the relay (ADR-0014) |
| `reviews.outbox` | `evidence` | Append-only operational residue; **must** declare a purge horizon |

`reviews.outbox` is the one `evidence` row, and the gate refuses it without a horizon: processed rows
are purged `processedOutboxRetainMs` after `processed_at` and parked (`dead`) rows
`deadOutboxRetainMs` after theirs, both applied by the spine's retention pass and both required to
exceed the reconciler's `staleAfterMs`. The composition root owns the numbers (SPEC-0004).

### Conventions this DDL satisfies

Stated as the gate's own rule ids (`tools/arch-checks/src/migration-ddl.ts`), so a reviewer can check
this document against the checker rather than against memory: `snake_case` throughout; singular
non-reserved table names (`plural-table-name`, `reserved-word`); `<table>_id` primary keys outside
the projection exemption (`entity-pk-not-table-id`); named constraints on every rule, prefixed
`pk_`/`uq_`/`fk_`/`ck_` and indexes `ix_` (`constraint-unnamed`, `constraint-name-pattern`); no
abbreviations (`abbreviation-denied` — `description` not `desc`, `rating_average` not `avg_rating`);
no native enum types and no `IF NOT EXISTS` (`enum-type-banned`, `if-not-exists-banned`);
`timestamptz` only (`timestamp-without-timezone`); no nullable booleans (`nullable-boolean` — this
schema has no boolean at all); every `updated_at` paired with its trigger
(`updated-at-without-trigger`); `INSERT` only into reference tables (`insert-into-non-reference-table`
— which is why seed data is a command, not a migration); and a registry row per table
(`lifecycle-registry-missing-row`).

### Seed data (the shape TASK-0006 fills)

Five categories; roughly twenty products spread across them, each with a real slug
(`sony-wh-1000xm5`) and a real SKU (`AUD-WH1000XM5`); six review authors; reviews with a
**deliberately non-uniform** rating distribution and dates spread over recent months. At least one
product carries enough reviews that its average is not trivially one rating (TASK-0006's criterion),
at least one product has exactly one review, and at least one has none — the three states SPEC-0001's
screens must render.

One seeded account has `catalogue_manager = true` and a second (may be the same account, may be
different) has `moderator = true`, so both authoring (S7) and moderation (S8) surfaces are reachable
immediately after `bun run setup`, and the 403 path for each is reachable through every other seeded
account. At least one seeded review is left `rejected`, so the moderation screen's `rejected` filter
has something to show on a fresh checkout rather than only on a hand-tested one.

Seeding is idempotent by slug — the natural key is what makes "insert or update" expressible without
a second identifier — and it enqueues a recomputation per product rather than writing
`product_rating` directly, so the seed exercises the same path production does.

## Open questions

1. **User erasure and the projection.** Deleting an `auth.identity` cascades to reviews, leaving
   `product_rating` stale until something recomputes. Proposal: erasure enqueues a recomputation for
   every affected product, the same event the write path emits (SPEC-0004). Not built in v1 — there
   is no erasure surface — but the cascade exists today and the gap should be recorded rather than
   discovered.
2. **Product deletion.** `ON DELETE CASCADE` removes reviews and the projection row. There is no
   deletion surface in v1; if products later need to be retired rather than deleted, that is a state
   column and the cascade becomes wrong.
3. **`title` requiredness.** A required title is specified (`char_length(title) BETWEEN 3 AND 120`).
   Amazon allows a body-only review; making it optional later is a nullable column and a relaxed Zod
   schema, in that order.
4. **A renamed product keeps its slug.** The slug is frozen at creation (ADR-0016 rejected a
   redirect-history table for a catalogue with no public traffic yet), so a product renamed from
   "WH-1000XM5" to "WH-1000XM5 Mark II" keeps `sony-wh-1000xm5`. That is a link that still resolves
   and a URL that reads slightly stale — the right trade here, and the wrong one the day the
   catalogue is indexed by a search engine. The fix, when it is needed, is the redirect table that
   record names.
5. **Full-text search.** The catalogue filter is a substring match on `name` (SPEC-0003), which uses
   no index. At catalogue scale that is fine and it is stated here so that the day it is not, the fix
   is a known one (a trigram index, or a search context).

## Traceability

| Part of this specification | Constrained by | Implemented by |
|---|---|---|
| Schema per context, one migration file | ADR-0001, ADR-0006 | TASK-0002 |
| `reference.product_category`, `reference.review_moderation_state` | ADR-0016 | TASK-0002 |
| `reviews.product`, `reviews.review` | ADR-0016 | TASK-0002 |
| Slug and SKU identity, and their immutability | ADR-0016 | TASK-0002, TASK-0008 |
| `auth.app_user.catalogue_manager` | ADR-0018 | TASK-0008 |
| `auth.app_user.moderator`, moderation state transitions | ADR-0018 | TASK-0009 |
| One-review-per-author unique constraint → typed `ConflictError` | ADR-0008, ADR-0016 | TASK-0002, TASK-0003 |
| `reviews.product_rating`, its nullability rule and `computed_at` | ADR-0014 | TASK-0002, TASK-0005 |
| Entity vocabularies and their parity tests | ADR-0003, ADR-0010 | TASK-0002 |
| Lifecycle registry rows | ADR-0006 | TASK-0002 |
| Public identifiers and the wire/internal id split | ADR-0016, ADR-0018 | TASK-0002, TASK-0003 |
| Seed shape and idempotence | ADR-0005 | TASK-0006 |
