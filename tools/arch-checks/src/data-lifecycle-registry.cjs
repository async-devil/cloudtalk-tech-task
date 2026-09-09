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
};

module.exports = { LIFECYCLE_CLASS, REGISTRY };
