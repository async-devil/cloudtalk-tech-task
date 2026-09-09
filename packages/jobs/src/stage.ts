import { STAGE_STATUS } from '@repo/entities';
import { InternalError, NotFoundError } from '@repo/kernel';
import { rowAs } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import type { z } from 'zod';
import type { PipelineTableContract } from './contract.js';
import { writeDeadLetter } from './dead-letter.js';
import { acquireInstanceLock } from './internal/advisory-lock.js';
import { readAttemptResult, writeAttemptResult } from './internal/attempt-result.js';
import { attemptsRowSchema, stageStatusIdRowSchema } from './internal/rows.js';
import { instanceTableRef } from './internal/table-refs.js';
import { performExternalCallWithRouting } from './internal/terminal-routing.js';

/** The outcome of a `runPipelineStage`/`runPipelineBranch` run (frozen). */
export const STAGE_RUN_OUTCOME = {
  Completed: 'completed',
  /** State-check found the stage already completed: successors re-ensured, nothing else ran. */
  ReplayNoOp: 'replay-no-op',
  /** Stage is terminally failed (dead-lettered): ack and stop — never resurrect. */
  AlreadyFailed: 'already-failed',
} as const;
export type StageRunOutcome = (typeof STAGE_RUN_OUTCOME)[keyof typeof STAGE_RUN_OUTCOME];

// ---------------------------------------------------------------------------------------------
// claimStage (steps 2+3)
// ---------------------------------------------------------------------------------------------

export interface ClaimStageOptions {
  readonly db: Kysely<unknown>;
  readonly contract: PipelineTableContract;
  readonly stage: string;
  readonly instanceId: string;
  /** ADR-0007's uniform ceiling: claim attempts exceeding this dead-letter the stage. */
  readonly attemptsCeiling: number;
}

export type ClaimStageResult =
  | { readonly outcome: 'claimed'; readonly attempts: number }
  | { readonly outcome: typeof STAGE_RUN_OUTCOME.ReplayNoOp }
  | { readonly outcome: typeof STAGE_RUN_OUTCOME.AlreadyFailed };

/**
 * Steps 2+3 of ADR-0007's six-step shape, composed as ONE transaction: advisory lock ->
 * read `{stage}_stage_status_id` -> `completed` short-circuits to `ReplayNoOp` (successor
 * re-ensure is the caller's job — `claimStage` has no `ensureSuccessors` of its own), `failed`
 * short-circuits to `AlreadyFailed`, else claim (`in_progress`, `attempts += 1`,
 * regression-guarded on `pending|in_progress`). When the just-claimed attempts count EXCEEDS
 * `attemptsCeiling`, writes the dead letter in the SAME transaction and throws `InternalError`
 * (`retryable: false`) — the messaging boundary classifies it terminal and the queue stops
 * (ADR-0007's uniform ceiling, "no exceptions").
 */
export async function claimStage(options: ClaimStageOptions): Promise<ClaimStageResult> {
  const { db, contract, stage, instanceId, attemptsCeiling } = options;
  const statusColumn = `${stage}_stage_status_id`;
  const attemptsColumn = `${stage}_attempts`;
  const updatedAtColumn = `${stage}_updated_at`;

  // The ceiling branch below writes the dead letter and THEN must throw — but throwing INSIDE
  // `db.transaction().execute()`'s callback makes Kysely roll back the whole transaction,
  // undoing the very dead-letter row/status flip `writeDeadLetter` just wrote. So the callback
  // returns a tagged result instead of throwing; the actual `InternalError` throw happens AFTER
  // this transaction has committed (below), once the dead-letter write is durable.
  const outcome = await db.transaction().execute(async (trx) => {
    await acquireInstanceLock(trx, contract.pipeline, instanceId);

    const existing = await sql`
      SELECT ${sql.id(statusColumn)} AS stage_status_id
      FROM ${sql.table(instanceTableRef(contract))}
      WHERE ${sql.id(contract.instanceIdColumn)} = ${instanceId}
    `.execute(trx);
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      throw new NotFoundError(
        `claimStage: ${contract.pipeline}.${stage}: no instance row for "${instanceId}"`,
      );
    }
    const { stage_status_id: statusId } = rowAs(stageStatusIdRowSchema, existingRow);

    if (statusId === STAGE_STATUS.Completed.id) {
      return { kind: STAGE_RUN_OUTCOME.ReplayNoOp } as const;
    }
    if (statusId === STAGE_STATUS.Failed.id) {
      return { kind: STAGE_RUN_OUTCOME.AlreadyFailed } as const;
    }

    const claimed = await sql`
      UPDATE ${sql.table(instanceTableRef(contract))}
      SET ${sql.id(statusColumn)} = ${STAGE_STATUS.InProgress.id},
          ${sql.id(attemptsColumn)} = ${sql.id(attemptsColumn)} + 1,
          ${sql.id(updatedAtColumn)} = now()
      WHERE ${sql.id(contract.instanceIdColumn)} = ${instanceId}
        AND ${sql.id(statusColumn)} IN (${STAGE_STATUS.Pending.id}, ${STAGE_STATUS.InProgress.id})
      RETURNING ${sql.id(attemptsColumn)} AS attempts
    `.execute(trx);
    const claimedRow = claimed.rows[0];
    if (claimedRow === undefined) {
      // Read and claim happen under the same advisory-locked transaction: a status flip between
      // them means a writer bypassed the lock — a spine bug, not a legitimate race.
      throw new InternalError(
        `claimStage: ${contract.pipeline}.${stage}: regression guard matched 0 rows for an instance read as pending/in_progress moments earlier`,
      );
    }
    const { attempts } = rowAs(attemptsRowSchema, claimedRow);

    if (attempts > attemptsCeiling) {
      await writeDeadLetter(trx, contract, {
        instanceId,
        stage,
        reason: 'claim: attempts ceiling reached',
        attempts,
      });
      return { kind: 'ceiling-reached' as const };
    }

    return { kind: 'claimed' as const, attempts };
  });

  if (outcome.kind === 'ceiling-reached') {
    throw new InternalError(`${contract.pipeline}.${stage}: attempts ceiling reached`, {
      retryable: false,
    });
  }
  if (
    outcome.kind === STAGE_RUN_OUTCOME.ReplayNoOp ||
    outcome.kind === STAGE_RUN_OUTCOME.AlreadyFailed
  ) {
    return { outcome: outcome.kind };
  }
  return { outcome: 'claimed', attempts: outcome.attempts };
}

// ---------------------------------------------------------------------------------------------
// readStageResult / writeStageResult (steps 3->4->5)
// ---------------------------------------------------------------------------------------------

export interface ReadStageResultOptions<TResult> {
  readonly db: Kysely<unknown>;
  readonly contract: PipelineTableContract;
  readonly stage: string;
  readonly instanceId: string;
  /** Parses the write-ahead payload on replay (ADR-0004: a jsonb row is a boundary). */
  readonly resultSchema: z.ZodType<TResult>;
}

/** Reads the `{table}_stage_result` row for `attempt_token = stage`, or `undefined` when no
 * attempt has written a result yet. */
export function readStageResult<TResult>(
  options: ReadStageResultOptions<TResult>,
): Promise<TResult | undefined> {
  return readAttemptResult(
    options.db,
    options.contract,
    options.instanceId,
    options.stage,
    options.resultSchema,
  );
}

export interface WriteStageResultOptions<TResult> {
  readonly db: Kysely<unknown>;
  readonly contract: PipelineTableContract;
  readonly stage: string;
  readonly instanceId: string;
  readonly result: TResult;
  readonly resultSchema: z.ZodType<TResult>;
}

/** Write-ahead (step 4->5): `INSERT ... ON CONFLICT (instanceId, stage) DO
 * NOTHING`, then re-read — the row that EXISTS (ours or a concurrent winner's) is the result
 * carried forward. The primary key IS the idempotency mechanism (ADR-0007 step 5). */
export function writeStageResult<TResult>(
  options: WriteStageResultOptions<TResult>,
): Promise<TResult> {
  return writeAttemptResult(
    options.db,
    options.contract,
    options.instanceId,
    options.stage,
    options.resultSchema,
    options.result,
  );
}

// ---------------------------------------------------------------------------------------------
// completeStage (step 5->6)
// ---------------------------------------------------------------------------------------------

export interface CompleteStageOptions {
  readonly db: Kysely<unknown>;
  readonly contract: PipelineTableContract;
  readonly stage: string;
  readonly instanceId: string;
  /** Domain writes + outbox inserts, run inside the single completing transaction BEFORE the
   * regression-guarded status flip. Exists for the reconciler, the tests, and pipelines whose
   * shape genuinely cannot fit `runPipelineStage` (a worker using `completeStage`
   * directly needs a written justification in its module README, review-enforced). */
  readonly inTransaction?: (trx: Kysely<unknown>) => Promise<void>;
}

export type CompleteStageResult =
  | { readonly outcome: 'completed' }
  | { readonly outcome: typeof STAGE_RUN_OUTCOME.AlreadyFailed };

/**
 * Step 5->6: ONE transaction — advisory lock -> re-check status (a reconciler may have
 * dead-lettered a slow attempt: `failed` ⇒ rollback, return `AlreadyFailed`) -> run
 * `inTransaction` (if given) -> regression-guarded complete (`WHERE {stage}_status_id =
 * in_progress`). Guard lost (another attempt already completed) ⇒ still fine — the write-ahead
 * made both attempts carry the same result, so a 0-row UPDATE here is not an error.
 */
export function completeStage(options: CompleteStageOptions): Promise<CompleteStageResult> {
  const { db, contract, stage, instanceId, inTransaction } = options;
  const statusColumn = `${stage}_stage_status_id`;
  const updatedAtColumn = `${stage}_updated_at`;

  return db.transaction().execute(async (trx) => {
    await acquireInstanceLock(trx, contract.pipeline, instanceId);

    const existing = await sql`
      SELECT ${sql.id(statusColumn)} AS stage_status_id
      FROM ${sql.table(instanceTableRef(contract))}
      WHERE ${sql.id(contract.instanceIdColumn)} = ${instanceId}
    `.execute(trx);
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      throw new NotFoundError(
        `completeStage: ${contract.pipeline}.${stage}: no instance row for "${instanceId}"`,
      );
    }
    const { stage_status_id: statusId } = rowAs(stageStatusIdRowSchema, existingRow);
    if (statusId === STAGE_STATUS.Failed.id) {
      return { outcome: STAGE_RUN_OUTCOME.AlreadyFailed };
    }

    if (inTransaction !== undefined) {
      await inTransaction(trx);
    }

    await sql`
      UPDATE ${sql.table(instanceTableRef(contract))}
      SET ${sql.id(statusColumn)} = ${STAGE_STATUS.Completed.id},
          ${sql.id(updatedAtColumn)} = now()
      WHERE ${sql.id(contract.instanceIdColumn)} = ${instanceId}
        AND ${sql.id(statusColumn)} = ${STAGE_STATUS.InProgress.id}
    `.execute(trx);

    return { outcome: 'completed' };
  });
}

// ---------------------------------------------------------------------------------------------
// runPipelineStage (the six steps composed as ONE function)
// ---------------------------------------------------------------------------------------------

export interface StageRunOptions<TResult> {
  readonly db: Kysely<unknown>;
  readonly contract: PipelineTableContract;
  /** Must be in `contract.stages`. */
  readonly stage: string;
  readonly instanceId: string;
  /** ADR-0007's uniform ceiling: claim attempts exceeding this dead-letter the stage. */
  readonly attemptsCeiling: number;
  /** Step 4 — the paid/external call. Runs OUTSIDE any transaction, and NOT AT ALL when a
   * write-ahead row already exists (the no-re-bill guarantee). Throwing here routes through
   * `classifyRetry`. */
  readonly performExternalCall: () => Promise<TResult>;
  /** Parses the write-ahead payload on replay (ADR-0004: a jsonb row is a boundary). */
  readonly resultSchema: z.ZodType<TResult>;
  /** Step 6 — domain writes + outbox inserts, inside the single completing transaction (which
   * also flips `{stage}_status` to `completed`, regression-guarded). Runs at most once per
   * instance in the normal path (only one transaction ever wins the `in_progress -> completed`
   * flip); MUST be idempotent-in-effect on replay of an already-`completed` stage per —
   * `runPipelineStage` itself does not re-run it on replay, but `completeStage`'s own regression
   * guard (see its doc) means a concurrently-racing attempt can still invoke it once more. */
  readonly applyResult: (trx: Kysely<unknown>, result: TResult) => Promise<void>;
  /** Runs AFTER the commit — and again on every replay of a completed stage (ADR-0007 step 2:
   * "ack no-op + re-ensure successors"). Deterministic jobIds make it idempotent; enqueue only
   * through `@repo/messaging`. */
  readonly ensureSuccessors: () => Promise<void>;
}

/**
 * ADR-0007's six steps, composed as ONE function. Deviating workers are
 * review-rejected; using this composition makes conformance structural. See `claimStage` /
 * `readStageResult` / `writeStageResult` / `completeStage` for the granular steps this composes.
 */
export async function runPipelineStage<TResult>(
  options: StageRunOptions<TResult>,
): Promise<StageRunOutcome> {
  const claim = await claimStage({
    db: options.db,
    contract: options.contract,
    stage: options.stage,
    instanceId: options.instanceId,
    attemptsCeiling: options.attemptsCeiling,
  });

  if (claim.outcome === STAGE_RUN_OUTCOME.ReplayNoOp) {
    await options.ensureSuccessors();
    return STAGE_RUN_OUTCOME.ReplayNoOp;
  }
  if (claim.outcome === STAGE_RUN_OUTCOME.AlreadyFailed) {
    return STAGE_RUN_OUTCOME.AlreadyFailed;
  }

  const existingResult = await readStageResult({
    db: options.db,
    contract: options.contract,
    stage: options.stage,
    instanceId: options.instanceId,
    resultSchema: options.resultSchema,
  });

  const result =
    existingResult !== undefined
      ? existingResult
      : await writeStageResult({
          db: options.db,
          contract: options.contract,
          stage: options.stage,
          instanceId: options.instanceId,
          resultSchema: options.resultSchema,
          result: await performExternalCallWithRouting(
            options.db,
            options.contract,
            { instanceId: options.instanceId, stage: options.stage, attempts: claim.attempts },
            options.performExternalCall,
          ),
        });

  const completion = await completeStage({
    db: options.db,
    contract: options.contract,
    stage: options.stage,
    instanceId: options.instanceId,
    inTransaction: (trx) => options.applyResult(trx, result),
  });

  if (completion.outcome === STAGE_RUN_OUTCOME.AlreadyFailed) {
    return STAGE_RUN_OUTCOME.AlreadyFailed;
  }

  await options.ensureSuccessors();
  return STAGE_RUN_OUTCOME.Completed;
}
