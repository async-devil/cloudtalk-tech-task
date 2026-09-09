/**
 * ADR-0006 data-lifecycle registry: the machine-read map every `schema.table` must appear in,
 * naming the row's lifecycle class and — when the class is `evidence` — its purge horizon. The
 * ADR-0011 `migration-ddl.ts` gate (this file's sibling) fails any `CREATE TABLE` with no row
 * here, any `evidence` row with no `horizon`, and any row naming a `schema.table` that no
 * migration actually creates (the inverse-direction staleness check).
 *
 * CommonJS, not this workspace's default ESM (ADR-0002): mirrors `module-registry.cjs` exactly —
 * a plain data file `require()`d/`import`ed from the gate (`migration-ddl.ts`) and, potentially
 * later, any policy code that wants the same source.
 *
 * Classes describe REACHABILITY, not sensitivity:
 *   - `reference` — seeded vocabulary (ADR-0011); permanent, parity-tested.
 *   - `truth`     — canonical domain rows; live with the aggregate, die by domain action (erasure).
 *   - `evidence`  — append-only operational residue; MUST declare a purge horizon.
 *   - `projection`— rebuildable read model; maintained/erased only by events through the relay
 *                   (ADR-0014's rating-aggregation projection is the worked case).
 */
'use strict';

/** @typedef {'reference'|'truth'|'evidence'|'projection'} LifecycleClass */

const LIFECYCLE_CLASS = {
  Reference: 'reference',
  Truth: 'truth',
  Evidence: 'evidence',
  Projection: 'projection',
};

/**
 * `schema.table` -> `{ class, horizon? }`. `horizon` is a free-text description (not necessarily
 * a single number — see `jobs.dead_letter` below) required whenever `class === 'evidence'`; the
 * gate only checks it is present and non-empty, not its shape, because a per-pipeline horizon
 * genuinely cannot be one number on a table shared by every pipeline.
 *
 * @type {Readonly<Record<string, { class: LifecycleClass, horizon?: string }>>}
 */
const REGISTRY = {
  // packages/persistence/migrations/0002-create-jobs-spine.ts: the four spine vocabularies,
  // seeded from @repo/entities and parity-tested (ADR-0011's seeded-vocabulary proof).
  'reference.stage_status': { class: LIFECYCLE_CLASS.Reference },
  'reference.branch_status': { class: LIFECYCLE_CLASS.Reference },
  'reference.branch_kind': { class: LIFECYCLE_CLASS.Reference },
  'reference.outbox_row_status': { class: LIFECYCLE_CLASS.Reference },

  // packages/persistence/migrations/0002-create-jobs-spine.ts: jobs.dead_letter. Cross-schema,
  // uncascadable, ids-only payload — its horizon is deliberately NOT one registry-level number:
  // it is per-pipeline, set by each pipeline's composition root through
  // `purgeDeadLetters({ pipeline, retainMs, staleAfterMs })`, because one shared table cannot
  // carry one horizon when contexts differ but the `pipeline` column already makes per-pipeline
  // policy expressible. The string below documents the mechanism so the gate's "evidence needs a
  // horizon" check is satisfied by something true, not by inventing a single number nothing reads.
  'jobs.dead_letter': {
    class: LIFECYCLE_CLASS.Evidence,
    horizon:
      'per-pipeline via jobs.purgeDeadLetters({ pipeline, retainMs, staleAfterMs }) — no single registry-level horizon (ADR-0006)',
  },

  // packages/persistence/migrations/0003-create-auth.ts: the auth schema. `identity`/`app_user`/
  // `account` are `truth` — user erasure cascades from `auth.identity` (ON DELETE CASCADE reaches
  // session/account/verification and auth.app_user). `session`/`verification` are `evidence` with
  // a horizon each `purgeExpiredAuthRows` call enforces; the composition root owns the exact
  // numbers, guidance defaults noted below.
  'auth.identity': { class: LIFECYCLE_CLASS.Truth },
  'auth.app_user': { class: LIFECYCLE_CLASS.Truth },
  'auth.account': { class: LIFECYCLE_CLASS.Truth },
  'auth.session': {
    class: LIFECYCLE_CLASS.Evidence,
    horizon:
      'sessionRetainMs past expiry (guidance default 30d) via auth.purgeExpiredAuthRows — must be > 0; expired rows only (ADR-0006)',
  },
  'auth.verification': {
    class: LIFECYCLE_CLASS.Evidence,
    horizon:
      'verificationRetainMs past expiry (guidance default 7d) via auth.purgeExpiredAuthRows — must be > 0; expired rows only (ADR-0006)',
  },

  // packages/persistence/migrations/0004-create-reviews.ts: the reviews bounded context
  // (TASK-0002, SPEC-0002). The two vocabularies are seeded from @repo/entities and
  // parity-tested, exactly like the spine's four. `product`/`review` are `truth`: canonical
  // catalogue and domain rows that die by domain action (product deletion, erasure cascade).
  // `product_rating` is `projection` — this classification is the ONLY reason its `product_id`
  // primary key is legal: `entity-pk-not-table-id` exempts a projection-classed table by this
  // registry lookup, not by name (ADR-0014). `outbox` is `evidence`, shaped exactly like the jobs
  // spine's own outbox (ADR-0007); its horizon is deliberately not a single registry-level number
  // for the same reason `jobs.dead_letter`'s isn't — the composition root owns the numbers.
  'reference.product_category': { class: LIFECYCLE_CLASS.Reference },
  'reference.review_moderation_state': { class: LIFECYCLE_CLASS.Reference },
  'reviews.product': { class: LIFECYCLE_CLASS.Truth },
  'reviews.review': { class: LIFECYCLE_CLASS.Truth },
  'reviews.product_rating': { class: LIFECYCLE_CLASS.Projection },
  'reviews.outbox': {
    class: LIFECYCLE_CLASS.Evidence,
    horizon:
      'processedOutboxRetainMs past processed_at for processed rows, deadOutboxRetainMs past processed_at for dead (parked) rows — both required to exceed the reconciler staleAfterMs, applied by the spine retention pass; composition root owns the numbers (SPEC-0004)',
  },
};

module.exports = { LIFECYCLE_CLASS, REGISTRY };
