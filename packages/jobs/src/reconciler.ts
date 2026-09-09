import { BRANCH_KIND, BRANCH_STATUS, type BranchKindId, STAGE_STATUS } from '@repo/entities';
import { createWorker, type MessagingConnection, scheduleRepeatable } from '@repo/messaging';
import { createModuleObservability, METRIC_ATTRIBUTE } from '@repo/observability';
import { rowAs, rowsAs } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import type { PipelineTableContract } from './contract.js';
import { type DeadLetterRecord, writeDeadLetter } from './dead-letter.js';
import { acquireInstanceLock } from './internal/advisory-lock.js';
import { attemptsExhausted } from './internal/attempts.js';
import { forEachWithConcurrency } from './internal/concurrency.js';
import { toSegment } from './internal/identifiers.js';
import {
  branchAttemptsRowSchema,
  branchKeyRowSchema,
  instanceIdRowSchema,
  stageAttemptsRowSchema,
} from './internal/rows.js';
import { branchTableRef, instanceTableRef } from './internal/table-refs.js';
import { tickSchema } from './internal/tick.js';
import type { ScheduledWorkerHandle } from './scheduled-worker.js';

const obs = createModuleObservability('jobs');

export interface ReconcilerStageBinding {
  readonly stage: string;
  /** Re-enqueue a stale instance's job (deterministic jobId inside — typically the module's own
   * enqueue function). Owned-branch redrive receives the branchKey. */
  readonly enqueue: (instanceId: string, branchKey?: string) => Promise<void>;
  /** Remove the possibly-stuck queue job first (remove-then-re-add, ADR-0007) — built on the
   * `Enqueuer.remove` amendment. */
  readonly remove: (instanceId: string, branchKey?: string) => Promise<boolean>;
  /** Present only on fan-out stages: fired when a join heal finds all branches completed but the
   * join never ran (the missed-join class ADR-0007 inherited from the reference). */
  readonly onJoinCompleted?: (instanceId: string) => Promise<void>;
}

export interface ReconcilerOptions {
  readonly db: Kysely<unknown>;
  readonly contract: PipelineTableContract;
  readonly stages: ReadonlyArray<ReconcilerStageBinding>;
  /** A row is stale when `{stage}_updated_at` (or branch `updated_at`) is older than this. */
  readonly staleAfterMs: number;
  /** The ADR-0007 uniform ceiling — same number the stage/branch runners receive. */
  readonly attemptsCeiling: number;
}

export const RECONCILE_ACTION = {
  Redriven: 'redriven',
  Healed: 'healed',
  DeadLettered: 'dead_lettered',
  /** One unit's reconcile threw and the pass carried on without it — see
   * {@link reconcileStaleUnits}. */
  Failed: 'failed',
} as const;
export type ReconcileAction = (typeof RECONCILE_ACTION)[keyof typeof RECONCILE_ACTION];

/** `jobs.reconciler.run`: counter incremented once per scan pass. */
export const RECONCILER_RUN_INSTRUMENT = {
  name: 'jobs.reconciler.run',
  allowedAttributes: [METRIC_ATTRIBUTE.Queue],
} as const;
const reconcilerRunCounter = obs.createCounter(RECONCILER_RUN_INSTRUMENT);

/** `jobs.reconciler.action`: counter incremented once per action taken. */
export const RECONCILER_ACTION_INSTRUMENT = {
  name: 'jobs.reconciler.action',
  allowedAttributes: [METRIC_ATTRIBUTE.Stage, METRIC_ATTRIBUTE.Outcome],
} as const;
const reconcilerActionCounter = obs.createCounter(RECONCILER_ACTION_INSTRUMENT);

export interface ReconcileReport {
  readonly redriven: number;
  readonly healed: number;
  readonly deadLettered: number;
  /** Units this pass could not reconcile (their errors were isolated, not propagated). A pass
   * that reports `failed > 0` did NOT cover its whole backlog; the next pass retries them. */
  readonly failed: number;
}

function staleIntervalFragment(staleAfterMs: number) {
  return sql`now() - make_interval(secs => ${staleAfterMs / 1000})`;
}

/** How many independent stale units the reconciler processes at once (amendment,
 * review). Each unit's transaction takes that instance's own advisory lock, so distinct instances
 * never contend; a small fixed width overlaps their I/O on a large backlog while staying well
 * within a normal Postgres connection pool. `1` reproduces the original strictly-serial behavior. */
const RECONCILE_CONCURRENCY = 4;

/** The re-drive/dead-letter protocol shared by stale stages and stale branches (steps 1-3):
 * only the table, status column(s), dead-letter reason, and whether an aged unit is re-driven
 * differ — the claim-under-lock, re-check, uniform-ceiling, age-or-dead-letter sequence is one
 * thing. `reconcileStaleUnits` is that one thing; the two callers below supply the differences. */
interface StaleUnitReconcile<TUnit> {
  readonly stage: string;
  /** The instance whose advisory lock serializes this unit. */
  instanceIdOf(unit: TUnit): string;
  /** The still-open status this pass acts on; anything else means a normal completion raced the
   * scan between the stale SELECT and acquiring the lock. */
  readonly openStatusId: number;
  /** Re-read the unit's current status, attempts AND staleness under the lock; `undefined` if the
   * row is gone. `isStale` re-evaluates the same predicate the stale SELECT used — see the
   * re-check in {@link reconcileStaleUnits} for why re-reading the row alone is not enough. */
  reclaim(
    trx: Kysely<unknown>,
    unit: TUnit,
  ): Promise<
    { readonly statusId: number; readonly attempts: number; readonly isStale: boolean } | undefined
  >;
  /** Bump attempts (+ touch `updated_at` where the table has no trigger). */
  age(trx: Kysely<unknown>, unit: TUnit): Promise<void>;
  /** The dead-letter record written when attempts reach the uniform ceiling (ADR-0007). */
  deadLetterRecord(unit: TUnit, attempts: number): DeadLetterRecord;
  /** Re-drive transport for an aged unit; `undefined` for unit kinds that only age (a delegated
   * branch has no queue job of its own). */
  readonly redrive?: ((unit: TUnit) => Promise<void>) | undefined;
}

/** Ceiling ⇒ dead-letter; else `age` (attempts++) and, if the unit kind re-drives, `remove` then
 * `enqueue` (the state-check inside `claimStage`/`runPipelineBranch` makes a duplicate delivery a
 * no-op, so redrive is safe even when the original job was alive). Independent units — distinct
 * instance locks — are processed with bounded concurrency (amendment), and one unit's failure is
 * isolated from the rest of the pass (`failed` in the returned tally). */
async function reconcileStaleUnits<TUnit>(
  db: Kysely<unknown>,
  contract: PipelineTableContract,
  attemptsCeiling: number,
  units: ReadonlyArray<TUnit>,
  spec: StaleUnitReconcile<TUnit>,
): Promise<{
  readonly redriven: number;
  readonly deadLettered: number;
  readonly failed: number;
}> {
  let redriven = 0;
  let deadLettered = 0;
  let failed = 0;

  await forEachWithConcurrency(units, RECONCILE_CONCURRENCY, async (unit) => {
    // Per-unit isolation, the same discipline `relayOutboxBatch` applies per row (INV-7; review,
    // 2026-09-09). Everything below reaches outside this process — the transaction, and `redrive`'s
    // two Redis round-trips — so any one unit can fail transiently. Left to propagate, that one
    // failure abandoned every unit still queued behind it AND every later step of the pass (the
    // other branch kinds, the missed-join heal), turning a single Redis blip into a pass that
    // reconciled almost nothing. The unit stays stale and is picked up by the next pass; nothing
    // here is a state transition that a retry would double-apply.
    try {
      const outcome = await db.transaction().execute(async (trx) => {
        await acquireInstanceLock(trx, contract.pipeline, spec.instanceIdOf(unit));

        const current = await spec.reclaim(trx, unit);
        if (current === undefined) {
          return 'gone' as const;
        }
        if (current.statusId !== spec.openStatusId) {
          return 'already-moved' as const;
        }
        // The staleness predicate is re-evaluated UNDER THE LOCK, not just the row re-read
        // (review, 2026-09-09). The stale SELECT and this lock acquisition are separated by a
        // real window, and a worker that legitimately re-claimed the unit in that window
        // refreshed `updated_at` while leaving the status exactly where the scan found it —
        // `in_progress`/`Pending`. Checking status alone therefore cannot tell "stalled" from
        // "actively being worked", and re-driving the latter puts a second worker on a stage
        // whose external call is in flight. Re-reading staleness closes that window: the lock
        // serializes this transaction against the claim that refreshed the row.
        if (!current.isStale) {
          return 'reclaimed-elsewhere' as const;
        }
        if (attemptsExhausted(current.attempts, attemptsCeiling)) {
          await writeDeadLetter(trx, contract, spec.deadLetterRecord(unit, current.attempts));
          return 'dead-lettered' as const;
        }
        await spec.age(trx, unit);
        return 'aged' as const;
      });

      // Increments run after the awaited transaction settles; the `+= 1` itself has no interleaved
      // `await`, so concurrent units never corrupt the tallies (single-threaded JS).
      if (outcome === 'dead-lettered') {
        deadLettered += 1;
        reconcilerActionCounter.add(1, {
          stage: spec.stage,
          outcome: RECONCILE_ACTION.DeadLettered,
        });
      } else if (outcome === 'aged' && spec.redrive !== undefined) {
        await spec.redrive(unit);
        redriven += 1;
        reconcilerActionCounter.add(1, { stage: spec.stage, outcome: RECONCILE_ACTION.Redriven });
      }
    } catch (error) {
      failed += 1;
      reconcilerActionCounter.add(1, { stage: spec.stage, outcome: RECONCILE_ACTION.Failed });
      obs.logger.warn(
        {
          pipeline: contract.pipeline,
          stage: spec.stage,
          instanceId: spec.instanceIdOf(unit),
          cause: String(error),
        },
        'reconcilePipeline: stale unit failed; the pass continues without it',
      );
    }
  });

  return { redriven, deadLettered, failed };
}

/** Stale `in_progress` stages (step 1): always re-driven after aging. */
async function reconcileStaleStages(
  db: Kysely<unknown>,
  contract: PipelineTableContract,
  binding: ReconcilerStageBinding,
  staleAfterMs: number,
  attemptsCeiling: number,
): Promise<{
  readonly redriven: number;
  readonly deadLettered: number;
  readonly failed: number;
}> {
  const statusColumn = `${binding.stage}_stage_status_id`;
  const attemptsColumn = `${binding.stage}_attempts`;
  const updatedAtColumn = `${binding.stage}_updated_at`;

  const staleRows = await sql`
    SELECT ${sql.id(contract.instanceIdColumn)} AS instance_id
    FROM ${sql.table(instanceTableRef(contract))}
    WHERE ${sql.id(statusColumn)} = ${STAGE_STATUS.InProgress.id}
      AND ${sql.id(updatedAtColumn)} < ${staleIntervalFragment(staleAfterMs)}
  `.execute(db);
  const instanceIds = rowsAs(instanceIdRowSchema, staleRows.rows).map((row) => row.instance_id);

  return reconcileStaleUnits(db, contract, attemptsCeiling, instanceIds, {
    stage: binding.stage,
    openStatusId: STAGE_STATUS.InProgress.id,
    instanceIdOf: (instanceId) => instanceId,
    reclaim: async (trx, instanceId) => {
      const current = await sql`
        SELECT ${sql.id(statusColumn)} AS stage_status_id, ${sql.id(attemptsColumn)} AS attempts,
               ${sql.id(updatedAtColumn)} < ${staleIntervalFragment(staleAfterMs)} AS is_stale
        FROM ${sql.table(instanceTableRef(contract))}
        WHERE ${sql.id(contract.instanceIdColumn)} = ${instanceId}
      `.execute(trx);
      const row = current.rows[0];
      if (row === undefined) {
        return undefined;
      }
      const {
        stage_status_id: statusId,
        attempts,
        is_stale: isStale,
      } = rowAs(stageAttemptsRowSchema, row);
      return { statusId, attempts, isStale };
    },
    age: async (trx, instanceId) => {
      await sql`
        UPDATE ${sql.table(instanceTableRef(contract))}
        SET ${sql.id(attemptsColumn)} = ${sql.id(attemptsColumn)} + 1,
            ${sql.id(updatedAtColumn)} = now()
        WHERE ${sql.id(contract.instanceIdColumn)} = ${instanceId}
      `.execute(trx);
    },
    deadLetterRecord: (instanceId, attempts) => ({
      instanceId,
      stage: binding.stage,
      reason: 'reconciler: attempts ceiling reached while in_progress',
      attempts,
    }),
    redrive: async (instanceId) => {
      await binding.remove(instanceId);
      await binding.enqueue(instanceId);
    },
  });
}

/** Stale branches of one kind (steps 2/3): owned branches are redriven
 * (`remove`/`enqueue` with the branchKey) after aging; delegated branches are ONLY aged
 * (`attempts++`, no queue job exists to redrive) — every branch kind reaches the same ceiling,
 * no exceptions (ADR-0007). `updated_at` is bumped by `tg_{table}_branch__set_updated_at`
 * (ADR-0011), not by the `age` UPDATE. */
async function reconcileStaleBranches(
  db: Kysely<unknown>,
  contract: PipelineTableContract,
  binding: ReconcilerStageBinding,
  staleAfterMs: number,
  attemptsCeiling: number,
  kind: BranchKindId,
  redrive: boolean,
): Promise<{
  readonly redriven: number;
  readonly deadLettered: number;
  readonly failed: number;
}> {
  const staleRows = await sql`
    SELECT ${sql.id(contract.instanceIdColumn)} AS instance_id, branch_key
    FROM ${sql.table(branchTableRef(contract))}
    WHERE stage = ${binding.stage}
      AND branch_kind_id = ${kind}
      AND branch_status_id = ${BRANCH_STATUS.Pending.id}
      AND updated_at < ${staleIntervalFragment(staleAfterMs)}
  `.execute(db);
  const staleBranches = rowsAs(branchKeyRowSchema, staleRows.rows);

  return reconcileStaleUnits(db, contract, attemptsCeiling, staleBranches, {
    stage: binding.stage,
    openStatusId: BRANCH_STATUS.Pending.id,
    instanceIdOf: (stale) => stale.instance_id,
    reclaim: async (trx, stale) => {
      const current = await sql`
        SELECT branch_status_id, attempts,
               updated_at < ${staleIntervalFragment(staleAfterMs)} AS is_stale
        FROM ${sql.table(branchTableRef(contract))}
        WHERE ${sql.id(contract.instanceIdColumn)} = ${stale.instance_id}
          AND stage = ${binding.stage}
          AND branch_key = ${stale.branch_key}
      `.execute(trx);
      const row = current.rows[0];
      if (row === undefined) {
        return undefined;
      }
      const {
        branch_status_id: statusId,
        attempts,
        is_stale: isStale,
      } = rowAs(branchAttemptsRowSchema, row);
      return { statusId, attempts, isStale };
    },
    age: async (trx, stale) => {
      await sql`
        UPDATE ${sql.table(branchTableRef(contract))}
        SET attempts = attempts + 1
        WHERE ${sql.id(contract.instanceIdColumn)} = ${stale.instance_id}
          AND stage = ${binding.stage}
          AND branch_key = ${stale.branch_key}
      `.execute(trx);
    },
    deadLetterRecord: (stale, attempts) => ({
      instanceId: stale.instance_id,
      stage: binding.stage,
      branchKey: stale.branch_key,
      reason: `reconciler: attempts ceiling reached while stale (${redrive ? 'owned' : 'delegated'})`,
      attempts,
    }),
    redrive: redrive
      ? async (stale) => {
          await binding.remove(stale.instance_id, stale.branch_key);
          await binding.enqueue(stale.instance_id, stale.branch_key);
        }
      : undefined,
  });
}

/** Missed-join heal (step 4): fan-out stages where every branch is `Completed` but the
 * stage row still shows `Pending`/`InProgress` past staleness ⇒ fire `onJoinCompleted(instanceId)`
 * — the branch that closed the join is presumed to have raced a crash between its own commit and
 * firing the continuation. Best-effort: `onJoinCompleted`'s own downstream write (typically
 * `completeStage`) is itself regression-guarded, so a heal that fires on an instance that in fact
 * completed normally a moment earlier is a safe, idempotent no-op, not a double-apply. */
async function healMissedJoins(
  db: Kysely<unknown>,
  contract: PipelineTableContract,
  binding: ReconcilerStageBinding,
  staleAfterMs: number,
): Promise<{ readonly healed: number; readonly failed: number }> {
  if (binding.onJoinCompleted === undefined) {
    return { healed: 0, failed: 0 };
  }
  const statusColumn = `${binding.stage}_stage_status_id`;
  const updatedAtColumn = `${binding.stage}_updated_at`;

  const candidates = await sql`
    SELECT pipeline_instance.${sql.id(contract.instanceIdColumn)} AS instance_id
    FROM ${sql.table(instanceTableRef(contract))} AS pipeline_instance
    WHERE pipeline_instance.${sql.id(statusColumn)} IN (${STAGE_STATUS.Pending.id}, ${STAGE_STATUS.InProgress.id})
      AND pipeline_instance.${sql.id(updatedAtColumn)} < ${staleIntervalFragment(staleAfterMs)}
      AND EXISTS (
        SELECT 1 FROM ${sql.table(branchTableRef(contract))} AS branch_row
        WHERE branch_row.${sql.id(contract.instanceIdColumn)} = pipeline_instance.${sql.id(contract.instanceIdColumn)}
          AND branch_row.stage = ${binding.stage}
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${sql.table(branchTableRef(contract))} AS branch_row
        WHERE branch_row.${sql.id(contract.instanceIdColumn)} = pipeline_instance.${sql.id(contract.instanceIdColumn)}
          AND branch_row.stage = ${binding.stage}
          AND branch_row.branch_status_id <> ${BRANCH_STATUS.Completed.id}
      )
  `.execute(db);
  const instanceIds = rowsAs(instanceIdRowSchema, candidates.rows).map((row) => row.instance_id);

  const onJoinCompleted = binding.onJoinCompleted;
  let healed = 0;
  let failed = 0;
  for (const instanceId of instanceIds) {
    // Isolated per candidate for the same reason the stale units above are (review, 2026-09-09):
    // `onJoinCompleted` is the caller's own continuation, and one instance whose continuation
    // throws must not cost every candidate behind it — nor the remaining stages of the pass.
    try {
      await onJoinCompleted(instanceId);
      healed += 1;
      reconcilerActionCounter.add(1, { stage: binding.stage, outcome: RECONCILE_ACTION.Healed });
    } catch (error) {
      failed += 1;
      reconcilerActionCounter.add(1, { stage: binding.stage, outcome: RECONCILE_ACTION.Failed });
      obs.logger.warn(
        {
          pipeline: contract.pipeline,
          stage: binding.stage,
          instanceId,
          cause: String(error),
        },
        'reconcilePipeline: missed-join heal failed; the pass continues without it',
      );
    }
  }
  return { healed, failed };
}

/**
 * One reconciler scan pass (frozen mechanics — unit-testable seam; `startReconciler` is
 * its repeatable wiring). Every status literal is an id from the `@repo/entities` const, bound
 * into the `sql` template — never a digit typed into a query string (ADR-0003). The reconciler
 * never talks to providers and never touches write-ahead rows — it only re-issues transport and
 * moves state machines that provably stalled. `staleAfterMs` MUST comfortably exceed worst-case
 * stage duration including full BullMQ backoff.
 */
export async function reconcilePipeline(options: ReconcilerOptions): Promise<ReconcileReport> {
  // Record the run once per pass, unconditionally
  reconcilerRunCounter.add(1, { queue: options.contract.pipeline });

  let redriven = 0;
  let healed = 0;
  let deadLettered = 0;
  let failed = 0;

  for (const binding of options.stages) {
    const stale = await reconcileStaleStages(
      options.db,
      options.contract,
      binding,
      options.staleAfterMs,
      options.attemptsCeiling,
    );
    redriven += stale.redriven;
    deadLettered += stale.deadLettered;
    failed += stale.failed;

    const owned = await reconcileStaleBranches(
      options.db,
      options.contract,
      binding,
      options.staleAfterMs,
      options.attemptsCeiling,
      BRANCH_KIND.Owned.id,
      true,
    );
    redriven += owned.redriven;
    deadLettered += owned.deadLettered;
    failed += owned.failed;

    const delegated = await reconcileStaleBranches(
      options.db,
      options.contract,
      binding,
      options.staleAfterMs,
      options.attemptsCeiling,
      BRANCH_KIND.Delegated.id,
      false,
    );
    deadLettered += delegated.deadLettered;
    failed += delegated.failed;

    const joins = await healMissedJoins(
      options.db,
      options.contract,
      binding,
      options.staleAfterMs,
    );
    healed += joins.healed;
    failed += joins.failed;
  }

  return { redriven, healed, deadLettered, failed };
}

/**
 * Repeatable wiring: `scheduleRepeatable` (schedulerId `reconciler:{pipeline}`) + a
 * worker on stage `{pipeline}_reconciler` whose handler is `reconcilePipeline`. `stage`/`pipeline`
 * are run through `toSegment` — `PipelineTableContract.pipeline` is validated against ADR-0011's
 * `^[a-z][a-z0-9_]*$`, which legally permits underscores that ADR-0009's `assertSegment`
 * (`^[a-z0-9-]+$`) rejects. Returns the worker handle for shutdown.
 */
export async function startReconciler(
  options: ReconcilerOptions & {
    readonly connection: MessagingConnection;
    readonly everyMs: number;
  },
): Promise<ScheduledWorkerHandle> {
  const pipelineSegment = toSegment(options.contract.pipeline);
  const stage = `${pipelineSegment}-reconciler`;

  // Hoisted so the schedule registration below and the returned handle name ONE declaration
  //: a consumer probing whether this schedule exists in Redis must read the
  // id we actually registered, never a second copy of the formula.
  const schedulerId = `reconciler:${options.contract.pipeline}`;
  await scheduleRepeatable({
    stage,
    connection: options.connection,
    schedulerId,
    every: { milliseconds: options.everyMs },
    data: {},
  });

  const worker = createWorker({
    stage,
    pipeline: pipelineSegment,
    connection: options.connection,
    schema: tickSchema,
    handler: async () => {
      await reconcilePipeline(options);
    },
  });

  return { ...worker, schedulerId, stage };
}
