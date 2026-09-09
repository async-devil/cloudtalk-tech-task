# jobs

## Purpose

The generic durability spine (ADR-0007):
ADR-0007's six-step idempotent worker shape composed as `runPipelineStage`/`runPipelineBranch`,
transactional-outbox helpers with per-row error isolation and parking (ADR-0007), a reconciler
that recovers stuck work from Postgres truth with a uniform attempts ceiling (ADR-0007), and the
ADR-0006 retention seam that purges the spine's own evidence tables. This package is
parameterized over caller-owned tables (`PipelineTableContract`) — it never owns a pipeline's
domain data, only the generic mechanics every pipeline needs.

`packages/example-context` is the living template that instantiates this spine end to
end; this package's own suites prove the spine's primitives in isolation.

**When NOT to use this.** A pipeline's own domain data, its business rules, or what a stage's
payload MEANS never belongs here — the `PipelineTableContract` parameterization exists precisely so
this package can stay ignorant of that. A new field, a new state, or a new stage's logic lives in
the owning pipeline's own tables and composition, never as a special case inside
`runPipelineStage`/`runPipelineBranch` themselves.

## Public contract

```ts
createPipelineTableContract(contract: PipelineTableContract): PipelineTableContract;

runPipelineStage<TResult>(options: StageRunOptions<TResult>): Promise<StageRunOutcome>;
claimStage(options: ClaimStageOptions): Promise<ClaimStageResult>;
completeStage(options: CompleteStageOptions): Promise<CompleteStageResult>;
readStageResult<TResult>(options: ReadStageResultOptions<TResult>): Promise<TResult | undefined>;
writeStageResult<TResult>(options: WriteStageResultOptions<TResult>): Promise<TResult>;

registerBranches(trx, contract, registration: RegisterBranchesOptions): Promise<void>;
runPipelineBranch<TResult>(options: BranchRunOptions<TResult>): Promise<StageRunOutcome>;
completeBranch(db, contract, branch: BranchIdentity): Promise<JoinDecision>;
failBranch(db, contract, branch: FailBranchOptions): Promise<void>;

writeDeadLetter(db, contract, record: DeadLetterRecord): Promise<void>;

insertOutboxRows(trx, outbox: OutboxTableRef, rows: ReadonlyArray<OutboxInsert>): Promise<void>;
relayOutboxBatch(options: OutboxRelayOptions): Promise<OutboxRelayReport>;
startOutboxRelay(options: OutboxRelayOptions & { connection; everyMs }): Promise<{ close(): Promise<void> }>;
computeOldestPendingAgeMs(oldestCreatedAt: Date, now: Date): number;

reconcilePipeline(options: ReconcilerOptions): Promise<ReconcileReport>;
startReconciler(options: ReconcilerOptions & { connection; everyMs }): Promise<{ close(): Promise<void> }>;

purgePipelineData(options: RetentionOptions): Promise<RetentionReport>;
startRetention(options: RetentionOptions & { connection; everyMs }): Promise<{ close(): Promise<void> }>;
purgeDeadLetters(options: PurgeDeadLettersOptions): Promise<number>;

STAGE_RUN_OUTCOME: { Completed; ReplayNoOp; AlreadyFailed };
JOIN_DECISION: { CompletedNow; Pending };
RECONCILE_ACTION: { Redriven; Healed; DeadLettered; Failed };
```

## Dependencies

`kysely@0.29.3`, `zod@4.4.3` (registry table) + workspace `@repo/kernel` (errors), `@repo/entities`
(the spine's four vocabularies + token minter), `@repo/observability` (`createModuleObservability`,
the dead-letter boundary log), `@repo/messaging` (`scheduleRepeatable`/`createWorker`/
`MessagingConnection` for the three `start*` wirings — never `bullmq`/`ioredis` directly), and
`@repo/persistence` (`rowAs`/`rowsAs` — a sanctioned Tier-2 edge, `tools/arch-checks/src/module-registry.cjs`).
Never imports `pg`, `bullmq`, or `ioredis` directly: Postgres arrives as an injected `Kysely`
handle, Redis/BullMQ only through `@repo/messaging`.

## Migrations folder

`migrations/0002-create-jobs-spine.ts` — global migration index `2` (ADR-0011's numbering
correction: a module's first migration is numbered by its place in the whole workspace's
dependency order, not by being that module's first). Creates schema `jobs`, seeds the four
`reference` vocabularies (`stage_status`, `branch_status`, `branch_kind`, `outbox_row_status`)
from the `@repo/entities` consts, and creates `jobs.dead_letter`. Runs after
`packages/persistence/migrations/0001-create-persistence-bootstrap.ts` (which creates the
`reference` schema this migration seeds into).

## Named invariants

<!-- Every invariant maps to a test id (ADR-0010.4); docs-check enforces. -->

- **INV-1** — `createPipelineTableContract` throws kernel `ValidationError` on any identifier not
  matching `^[a-z][a-z0-9_]*$`, on `instanceIdColumn !== \`${table}_id\``, and on any derived
  identifier (table names, `fk_{table}__stage_status__{stage}` constraint names) exceeding
  PostgreSQL's 63-byte limit — the ONLY gate between contract strings and `sql.id`/`sql.table`
  interpolation. Test: `test/contract.test.ts`.
- **INV-2** — the six-step shape is composed in `runPipelineStage` as ONE function: write-ahead
  BEFORE completion means a stored result is never re-fetched from the provider on replay
  (`readStageResult` short-circuits `performExternalCall` entirely when a row exists). Deviation
  needs written justification (ADR-0007 "deviations are review-rejected"). Test:
  `test-integration/stage.test.ts` (claim/write-ahead-conflict), `test/terminal-routing.test.ts`.
- **INV-3** — every status flip is regression-guarded: `claimStage`'s `UPDATE` only matches
  `pending|in_progress`; `completeStage`'s only matches `in_progress` (a lost guard — a
  concurrent attempt already completed — is not an error, both attempts carry the same
  write-ahead result); `completeBranch`'s only matches `Pending`. Test:
  `test-integration/stage.test.ts`, `test-integration/branch.test.ts`.
- **INV-4** — joins are decided by COUNTING open branch rows inside the same advisory-locked
  transaction that closed the last one — never inferred from transport. Exactly one caller per
  instance ever observes `JOIN_DECISION.CompletedNow`. Test: `test-integration/branch.test.ts`
  (completeBranch-count).
- **INV-5** — `writeDeadLetter` is ONE transaction: insert the dead-letter row (`ON CONFLICT DO
  NOTHING`, replay-safe), set `{stage}_stage_status_id = Failed`, and close every still-`Pending`
  branch of `(instance, stage)` as `Failed` with the same (truncated) reason. `payload` carries
  identifiers/classification only, never content (ADR-0006); `reason`/`last_error` are
  truncated to `REASON_MAX_LENGTH` (500) characters. Test: `test-integration/dead-letter.test.ts`.
- **INV-6** — the uniform attempts ceiling has no exceptions: a stage, an OWNED branch, and a
  DELEGATED branch (aged by the reconciler, never redriven — no queue job exists for it) all
  dead-letter identically once attempts reach the ceiling (ADR-0007). Test:
  `test-integration/stage.test.ts`, `test-integration/branch.test.ts`,
  `test-integration/reconciler.test.ts`.
- **INV-7** — `relayOutboxBatch` isolates per-row failures inside ONE transaction per pass: a
  poison row's `apply` throwing does not roll back siblings already marked `Processed` in the
  same pass; a row parks (`Dead`) once `attempts >= maxAttempts`, one `warn` log per newly-parked
  row. Test: `test-integration/outbox.test.ts`.
- **INV-8** — `reconcilePipeline` derives every action from Postgres truth alone (no Redis read):
  stale `in_progress` stages and stale `Pending` owned branches are redriven
  (`Enqueuer.remove` then re-`enqueue`, dedup-safe by the state-check inside `claimStage`); stale
  delegated branches are only aged. Under the instance lock it re-evaluates the SAME staleness
  predicate as the stale scan, not just the row's status: a unit legitimately re-claimed between
  the scan and the lock is `in_progress` AND fresh, and re-driving it would put a second worker on
  an in-flight external call. Test: `test-integration/reconciler.test.ts`.
- **INV-12** — one unit's failure never costs the pass: a throwing transaction, `redrive` or
  `onJoinCompleted` is contained per unit (ticked as `failed` on `jobs.reconciler.action`, one
  `warn`, counted in `ReconcileReport.failed`), and the remaining units, branch kinds and the
  missed-join heal still run. The unit stays stale for the next pass. Same discipline as INV-7's
  per-row isolation. Test: `test-integration/reconciler.test.ts`.
- **INV-13** — the uniform ceiling is ONE predicate (`internal/attempts.ts`): the claim path
  (post-increment attempts) and the reconciler (pre-age attempts) read it through adapters that
  name their vantage, so the last allowed attempt cannot drift between them. Test:
  `test/attempts.test.ts`.
- **INV-9** — `purgePipelineData`/`startRetention` throw kernel `ValidationError` BEFORE touching
  the database when any retention horizon is `<= staleAfterMs` (ADR-0006's floor — a purge
  inside the in-flight window would re-bill the provider); `Pending` outbox rows are never
  touched by retention. Test: `test/retention-validation.test.ts`.
- **INV-10** — `computeOldestPendingAgeMs` is a pure function (`report math`): the backlog
  histogram's input is unit-testable without a database. Test: `test/outbox-report-math.test.ts`.
- **INV-11** — the relay's contract, stated after the 2026-07-19 audit (ADR-0007 amendment note):
  `apply` runs **inside** the single claim transaction — a recorded
  polling-publisher exception to the six-step shape's step-4 law (which governs the stage
  runners' billing calls, not the relay). Operating bound: the transaction is held for
  ~`batchSize × apply-latency`; tune `batchSize` down for slow consumers and keep a pass
  comfortably under `idle_in_transaction_session_timeout`; a crash mid-pass replays the whole
  batch (absorbed by `apply` idempotency). Per-aggregate ordering holds **only under a single
  relay per outbox** — what `startOutboxRelay`'s idempotent `scheduleRepeatable` scheduler
  provides; a deployment scaling relays horizontally must make its applies order-tolerant per
  aggregate and record that in its own README. Test: `test-integration/outbox.test.ts` (pass
  semantics; the scheduler-idempotency half is 's pinned messaging invariant).

- **INV-12** — `startOutboxRelay`/`startReconciler`/`startRetention` return a
  `ScheduledWorkerHandle`: the real `WorkerHandle` (so `isReady()` is callable) plus the
  `schedulerId` and `stage` they registered. They previously returned `{ close() }`, which made a
  caller's health probe blind to these three workers and forced anyone probing their schedules to
  re-derive private id formulas — the drift that makes a "missing scheduler" check match nothing
  and report healthy forever. Consumers read the registration facts; they never reconstruct them.
  Test: `packages/example-context/test-integration/check-health.test.ts` (the consumer-side scope
  assertions).

## Telemetry

Source records: [ADR-0007](../../docs/adr/ADR-0007-jobs-transport-and-durability-spine.md) and
[ADR-0009](../../docs/adr/ADR-0009-observability-through-a-facade.md).

<!-- Every emitted span and instrument maps to a line here; the telemetry-map gate enforces both
     directions — against src/ and against the records linked above. -->

**Spans:** none. The spine's units of work run under spans opened elsewhere — worker stages under
messaging's runtime-named `jobs.{pipeline}.{stage}` spans, relay/reconciler passes under their
schedulers — and the spine adds no per-stage span of its own (one span per unit of work,
ADR-0009).

**Instruments:**

| instrument | kind | attributes | values / semantics |
|---|---|---|---|
| `jobs.outbox.run` | counter | Queue | one tick per relay pass, even empty (idle ≠ wedged); Queue = the qualified outbox name `{schema}.{table}` |
| `jobs.outbox.relay` | counter | Queue, Outcome | per row: `processed` / `failed` / `parked` |
| `jobs.outbox.backlog` | histogram, unit `ms` | Queue | `oldestPendingAgeMs` per non-empty pass |
| `jobs.reconciler.run` | counter | Queue | one tick per scan pass; Queue = pipeline |
| `jobs.reconciler.action` | counter | Stage, Outcome | `redriven` / `healed` / `dead_lettered` / `failed` (one unit the pass could not reconcile; the pass continued) |
| `jobs.retention.run` | counter | Queue | one tick per retention pass, even empty; Queue = pipeline (ADR-0006) |
| `jobs.retention.purged` | counter | Queue, Outcome | one add per target with the rows deleted: `stage_result` / `outbox_processed` / `outbox_dead` / `dead_letter` (ADR-0006) |
| `jobs.dead-letter.write` | counter | Stage | every dead-letter row, whatever path wrote it. Dashed rather than `jobs.dead_letter.write`: ADR-0009's segment charset is `[a-z0-9-]`, so an underscore throws at `createCounter` time — see `src/dead-letter.ts` |

No instance ids on metrics, ever — ids live on spans and logs (ADR-0009 cardinality budget).

## Extraction steps

Tier-capability, liftable: depends on `kysely`/`zod` and the liftable workspace modules listed
above (`@repo/kernel`, `@repo/entities`, `@repo/observability`, `@repo/messaging`,
`@repo/persistence` — all liftable themselves). No `pg`/`bullmq`/`ioredis` import anywhere in
`src/` — Postgres and Redis both arrive as injected handles from the composition root, so this
package carries no provider-specific runtime coupling to lift.

1. Copy `packages/jobs/` to the target repository.
2. Vendor or re-add its five workspace deps and `bun install`.
3. `tsc` build and `vitest run` must pass standalone; the Testcontainers `postgres:18` suite
   (`vitest run --config vitest.integration.config.ts`) additionally needs Docker.
