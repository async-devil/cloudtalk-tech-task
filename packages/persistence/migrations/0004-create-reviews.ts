import { type Kysely, sql } from 'kysely';

/**
 * The `reviews` bounded context's schema (TASK-0002, SPEC-0002): schema `reviews`, its two closed
 * vocabularies in the shared `reference` schema, the catalogue and review tables, the
 * rating-aggregate projection, and the context's own outbox. Global migration index `0004`:
 * `reference` already exists (`0001-create-persistence-bootstrap.ts`), and `reviews.review`
 * references `auth.app_user` (`0003-create-auth.ts`), so this migration must run after both.
 *
 * Nothing below is a design choice made in this file — SPEC-0002's "Specification" section is the
 * complete DDL, written to satisfy the `migration-ddl` gate exactly as it enforces ADR-0016; this
 * migration is a transcription of it, not a redesign. What follows records only the decisions
 * SPEC-0002 itself explains, so a reader does not have to hold both documents open at once:
 *
 * - **`reference.product_category` and `reference.review_moderation_state`** are closed
 *   vocabularies (ADR-0016: a new value is an insert, not a migration, and the table can be joined
 *   for a display label). Both are seeded here from the `{ id, name }` const objects in
 *   `@repo/entities` (`PRODUCT_CATEGORY`, `REVIEW_MODERATION_STATE`) — the literal `VALUES` below
 *   are that source transcribed, exactly as `0002-create-jobs-spine.ts` transcribes its four
 *   vocabularies, and `packages/reviews/test-integration/reference-parity.test.ts` is what proves
 *   the two stay one thing. Ids are the contract and are never renumbered.
 * - **`reviews.product.slug` and `.sku` are immutable after creation, and neither immutability is a
 *   `CHECK`.** A check constraint cannot see the old row; the rule lives in the write pipeline
 *   (SPEC-0003: `products.update` rejects either field) and is only as good as the test that proves
 *   it (ADR-0010). `slug` is the product's public identifier (ADR-0016) — a catalogue is enumerable
 *   by construction, so an opaque token would protect nothing the catalogue screen does not already
 *   hand out. `sku` is a business identifier, stored beside it, never a path segment.
 * - **`reviews.product_rating` is keyed by `product_id`, not `product_rating_id`.** ADR-0016's
 *   `<table>_id` rule exists to make a foreign-key column self-describing; a projection keyed
 *   one-to-one by its subject has nothing left to describe. The `migration-ddl` gate's
 *   `entity-pk-not-table-id` rule exempts this by the data-lifecycle registry's `projection` class
 *   (`tools/arch-checks/src/data-lifecycle-registry.cjs`), not by table name, so this needs no gate
 *   edit. The table carries no row until the first recomputation after a product's first review —
 *   never a zero-row insert at product-creation time — and its third `CHECK` makes "no reviews" and
 *   "no average" the same fact rather than two that could disagree. It has no `updated_at`: the
 *   worker sets `computed_at` explicitly on every recomputation, including one that finds nothing
 *   changed, so a trigger would be the wrong writer.
 * - **`reviews.outbox` transcribes the jobs spine's outbox shape (ADR-0007), not a new design.**
 *   `@repo/jobs`'s relay takes an `OutboxTableRef` and reads exactly these columns, so this context's
 *   outbox is shaped identically to `jobs.dead_letter`'s sibling outbox rather than invented per
 *   module. Its lifecycle-registry row is `evidence` and carries a purge horizon — see
 *   `tools/arch-checks/src/data-lifecycle-registry.cjs` for the composition-root-owned numbers.
 * - **Every index here is added with the query that needs it** (ADR-0016): the category filter
 *   (`ix_product__product_category_id`), the product review list's keyset pagination
 *   (`ix_review__product_id__created_at`), the own-review lookup / erasure fan-out
 *   (`ix_review__author_id`), and the outbox relay's claim
 *   (`ix_outbox__outbox_row_status_id__outbox_id`).
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`CREATE SCHEMA reviews`.execute(db);

  // -----------------------------------------------------------------------------------------
  // reference.product_category
  // -----------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE reference.product_category (
      product_category_id integer NOT NULL,
      name                 text    NOT NULL,
      CONSTRAINT pk_product_category PRIMARY KEY (product_category_id),
      CONSTRAINT uq_product_category__name UNIQUE (name)
    )
  `.execute(db);
  await sql`
    COMMENT ON TABLE reference.product_category IS
      'The catalogue''s closed category vocabulary (ADR-0016). Source: PRODUCT_CATEGORY in @repo/entities; seeded here and parity-tested. Ids are the contract — never renumber.'
  `.execute(db);
  await sql`
    INSERT INTO reference.product_category (product_category_id, name) VALUES
      (1, 'audio'), (2, 'computing'), (3, 'home'), (4, 'outdoor'), (5, 'kitchen')
  `.execute(db);

  // -----------------------------------------------------------------------------------------
  // reference.review_moderation_state
  // -----------------------------------------------------------------------------------------
  await sql`
    CREATE TABLE reference.review_moderation_state (
      review_moderation_state_id integer NOT NULL,
      name                       text    NOT NULL,
      CONSTRAINT pk_review_moderation_state PRIMARY KEY (review_moderation_state_id),
      CONSTRAINT uq_review_moderation_state__name UNIQUE (name)
    )
  `.execute(db);
  await sql`
    COMMENT ON TABLE reference.review_moderation_state IS
      'A review''s moderation-state vocabulary (ADR-0016, ADR-0018). Source: REVIEW_MODERATION_STATE in @repo/entities; seeded here and parity-tested. pending is seeded but written by nothing in v1 — reserved for a future reporting flow (SPEC-0002). Ids are the contract — never renumber.'
  `.execute(db);
  await sql`
    INSERT INTO reference.review_moderation_state (review_moderation_state_id, name) VALUES
      (1, 'published'), (2, 'pending'), (3, 'rejected')
  `.execute(db);

  // -----------------------------------------------------------------------------------------
  // reviews.product
  // -----------------------------------------------------------------------------------------
  await sql`
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
  `.execute(db);
  await sql`
    COMMENT ON TABLE reviews.product IS
      'The catalogue''s canonical product rows (ADR-0016). Addressed publicly by slug, never by product_id; slug and sku are immutable after creation by pipeline guard, not by CHECK — a CHECK cannot see the old row.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN reviews.product.slug IS
      'The product''s public identifier (ADR-0016): the API path segment and SPA route key. Frozen at creation by the write pipeline (SPEC-0003 products.update rejects it), proven by a test that mutates the guard and watches it fail (ADR-0010).'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN reviews.product.sku IS
      'A business identifier, not an address (ADR-0016): unique and immutable, but never a path segment, so it can always be corrected in the business it names without breaking a URL.'
  `.execute(db);
  await sql`
    CREATE TRIGGER tg_product__set_updated_at
      BEFORE UPDATE ON reviews.product
      FOR EACH ROW EXECUTE FUNCTION persistence.set_updated_at()
  `.execute(db);
  await sql`
    CREATE INDEX ix_product__product_category_id ON reviews.product (product_category_id)
  `.execute(db);

  // -----------------------------------------------------------------------------------------
  // reviews.review
  // -----------------------------------------------------------------------------------------
  await sql`
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
  `.execute(db);
  await sql`
    COMMENT ON TABLE reviews.review IS
      'Canonical review rows (ADR-0016). uq_review__product_id__author_id is the one-review-per-author rule (SPEC-0001 rule 2); the pipeline catches its violation and raises a typed ConflictError (ADR-0008) rather than letting a raw driver error escape.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN reviews.review.author_id IS
      'References auth.app_user.app_user_id — the app-owned user record — never auth.identity.id. ON DELETE CASCADE: user erasure cascades from auth.identity through auth.app_user to here.'
  `.execute(db);
  await sql`
    CREATE TRIGGER tg_review__set_updated_at
      BEFORE UPDATE ON reviews.review
      FOR EACH ROW EXECUTE FUNCTION persistence.set_updated_at()
  `.execute(db);
  await sql`
    CREATE INDEX ix_review__product_id__created_at ON reviews.review (product_id, created_at DESC)
  `.execute(db);
  await sql`CREATE INDEX ix_review__author_id ON reviews.review (author_id)`.execute(db);

  // -----------------------------------------------------------------------------------------
  // reviews.product_rating — the rebuildable rating-aggregate projection (ADR-0014).
  // -----------------------------------------------------------------------------------------
  await sql`
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
  `.execute(db);
  await sql`
    COMMENT ON TABLE reviews.product_rating IS
      'The rating-aggregate projection (ADR-0014): rebuildable from reviews.review at any time, never authoritative on its own. Keyed by product_id, not product_rating_id — a one-to-one projection has nothing a table_id would describe (data-lifecycle-registry.cjs classes it projection, which is what exempts it from entity-pk-not-table-id). No row exists until the first recomputation after a product''s first review.'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN reviews.product_rating.rating_average IS
      'The only nullable column in this schema. NULL exactly when review_count = 0 (enforced by ck_product_rating__average_present_when_reviewed) so "no reviews" and "no average" are one fact, never two that can disagree. Rendered as "No reviews yet", never 0.0 (SPEC-0001 rule 8).'
  `.execute(db);
  await sql`
    COMMENT ON COLUMN reviews.product_rating.computed_at IS
      'Not a row-modification timestamp — no trigger maintains it. The worker sets it explicitly on every recomputation, including one that finds nothing changed, so it can be rendered as "calculated N minutes ago".'
  `.execute(db);

  // -----------------------------------------------------------------------------------------
  // reviews.outbox — this context's own outbox (ADR-0007), shaped exactly like the jobs spine's.
  // -----------------------------------------------------------------------------------------
  await sql`
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
  `.execute(db);
  await sql`
    COMMENT ON TABLE reviews.outbox IS
      'The reviews context''s own outbox (ADR-0007) — transcribed from the jobs spine''s shape, not redesigned: @repo/jobs''s relay reads exactly these columns via an OutboxTableRef({ schema: "reviews", table: "outbox" }). Append-only evidence; purged on the horizon data-lifecycle-registry.cjs records.'
  `.execute(db);
  await sql`
    CREATE INDEX ix_outbox__outbox_row_status_id__outbox_id
      ON reviews.outbox (outbox_row_status_id, outbox_id)
  `.execute(db);
}

/** Local development only (ADR-0006): a production rollback is a forward migration. */
export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE reviews.outbox`.execute(db);
  await sql`DROP TABLE reviews.product_rating`.execute(db);
  await sql`DROP TABLE reviews.review`.execute(db);
  await sql`DROP TABLE reviews.product`.execute(db);
  await sql`DROP TABLE reference.review_moderation_state`.execute(db);
  await sql`DROP TABLE reference.product_category`.execute(db);
  await sql`DROP SCHEMA reviews`.execute(db);
}
