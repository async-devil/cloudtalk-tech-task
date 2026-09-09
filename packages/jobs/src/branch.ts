import { BRANCH_STATUS, type BranchKindId } from '@repo/entities';
import { InternalError, NotFoundError } from '@repo/kernel';
import { rowAs } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import type { z } from 'zod';
import type { PipelineTableContract } from './contract.js';
import { writeDeadLetter } from './dead-letter.js';
import { acquireInstanceLock } from './internal/advisory-lock.js';
import { readAttemptResult, writeAttemptResult } from './internal/attempt-result.js';
import { claimReachedCeiling } from './internal/attempts.js';
import { truncateReason } from './internal/reason.js';
import { attemptsRowSchema, branchStatusIdRowSchema, openCountRowSchema } from './internal/rows.js';
import { branchTableRef } from './internal/table-refs.js';
import { performExternalCallWithRouting } from './internal/terminal-routing.js';
import { STAGE_RUN_OUTCOME, type StageRunOutcome } from './stage.js';

/** The branch-kind value a branch is registered with ('s `BranchKind`) — an alias onto
 * `@repo/entities`' `BranchKindId` (`BRANCH_KIND.Owned.id` / `BRANCH_KIND.Delegated.id`); the
 * spec's own snippet does not otherwise define the name. */
export type BranchKind = BranchKindId;

export interface BranchIdentity {
  readonly instanceId: string;
  readonly stage: string;
  readonly branchKey: string;
}

// ---------------------------------------------------------------------------------------------
// registerBranches
// ---------------------------------------------------------------------------------------------

export interface RegisterBranchesOptions {
  readonly instanceId: string;
  readonly stage: string;
  readonly branches: ReadonlyArray<{ readonly branchKey: string; readonly kind: BranchKind }>;
}

/** Fan-out registration — idempotent (`ON CONFLICT DO NOTHING`), called inside the fanning
 * stage's `applyResult` transaction so branches exist iff the stage committed. */
export async function registerBranches(
  trx: Kysely<unknown>,
  contract: PipelineTableContract,
  registration: RegisterBranchesOptions,
): Promise<void> {
  for (const branch of registration.branches) {
    await sql`
      INSERT INTO ${sql.table(branchTableRef(contract))}
        (${sql.id(contract.instanceIdColumn)}, stage, branch_key, branch_kind_id)
      VALUES (${registration.instanceId}, ${registration.stage}, ${branch.branchKey}, ${branch.kind})
      ON CONFLICT (${sql.id(contract.instanceIdColumn)}, stage, branch_key) DO NOTHING
    `.execute(trx);
  }
}

// ---------------------------------------------------------------------------------------------
// completeBranch / failBranch
// ---------------------------------------------------------------------------------------------

export const JOIN_DECISION = {
  /** THIS call closed the last open branch — the caller (and only this caller) fires the join's
   * continuation. Exactly-once by the advisory lock + the pending-guard. */
  CompletedNow: 'completed-now',
  /** Branches remain open (or this branch was already terminal — replay). */
  Pending: 'pending',
} as const;
export type JoinDecision = (typeof JOIN_DECISION)[keyof typeof JOIN_DECISION];

/** Marks one branch completed (guard `branch_status_id = Pending`) and decides the join by
 * COUNTING open siblings, both inside the transaction the caller is already holding the
 * instance's advisory lock in. @internal shared by the public `completeBranch` and by
 * `runPipelineBranch`'s completing transaction. */
async function completeBranchLocked(
  trx: Kysely<unknown>,
  contract: PipelineTableContract,
  branch: BranchIdentity,
): Promise<JoinDecision> {
  const updated = await sql`
    UPDATE ${sql.table(branchTableRef(contract))}
    SET branch_status_id = ${BRANCH_STATUS.Completed.id}
    WHERE ${sql.id(contract.instanceIdColumn)} = ${branch.instanceId}
      AND stage = ${branch.stage}
      AND branch_key = ${branch.branchKey}
      AND branch_status_id = ${BRANCH_STATUS.Pending.id}
    RETURNING branch_status_id
  `.execute(trx);

  if (updated.rows.length === 0) {
    // Already terminal (completed by a concurrent winner, or failed) — replay-safe no-op.
    return JOIN_DECISION.Pending;
  }

  const openCount = await sql`
    SELECT count(*)::int AS open_count
    FROM ${sql.table(branchTableRef(contract))}
    WHERE ${sql.id(contract.instanceIdColumn)} = ${branch.instanceId}
      AND stage = ${branch.stage}
      AND branch_status_id = ${BRANCH_STATUS.Pending.id}
  `.execute(trx);
  const { open_count: remaining } = rowAs(openCountRowSchema, openCount.rows[0]);

  return remaining === 0 ? JOIN_DECISION.CompletedNow : JOIN_DECISION.Pending;
}

/** Marks one branch completed (guard `WHERE branch_status_id = Pending`) and decides the join by
 * COUNTING open siblings inside the same advisory-locked transaction. Public API — delegated
 * branches are completed by callback/webhook handlers calling exactly this. */
export function completeBranch(
  db: Kysely<unknown>,
  contract: PipelineTableContract,
  branch: BranchIdentity,
): Promise<JoinDecision> {
  return db.transaction().execute(async (trx) => {
    await acquireInstanceLock(trx, contract.pipeline, branch.instanceId);
    return completeBranchLocked(trx, contract, branch);
  });
}

export interface FailBranchOptions extends BranchIdentity {
  readonly reason: string;
}

/** `attempts++` / `last_error` on a still-`Pending` branch (reconciler + retry bookkeeping). */
export async function failBranch(
  db: Kysely<unknown>,
  contract: PipelineTableContract,
  branch: FailBranchOptions,
): Promise<void> {
  await sql`
    UPDATE ${sql.table(branchTableRef(contract))}
    SET attempts = attempts + 1, last_error = ${truncateReason(branch.reason)}
    WHERE ${sql.id(contract.instanceIdColumn)} = ${branch.instanceId}
      AND stage = ${branch.stage}
      AND branch_key = ${branch.branchKey}
      AND branch_status_id = ${BRANCH_STATUS.Pending.id}
  `.execute(db);
}

// ---------------------------------------------------------------------------------------------
// runPipelineBranch
// ---------------------------------------------------------------------------------------------

type ClaimBranchResult =
  | { readonly outcome: 'claimed'; readonly attempts: number }
  | { readonly outcome: typeof STAGE_RUN_OUTCOME.ReplayNoOp }
  | { readonly outcome: typeof STAGE_RUN_OUTCOME.AlreadyFailed };

/** `runPipelineStage`'s claim step, for one branch: advisory lock -> read `branch_status_id` ->
 * already-`Completed` ⇒ `ReplayNoOp`, already-`Failed` ⇒ `AlreadyFailed`, else `attempts += 1`
 * regression-guarded on `Pending`; ceiling ⇒ dead-letter (closes the branch and its siblings)
 * then throw. @internal `runPipelineBranch` is the only public surface for this step (
 * exports only `registerBranches`/`runPipelineBranch`/`completeBranch`/`failBranch`). */
async function claimBranch(
  db: Kysely<unknown>,
  contract: PipelineTableContract,
  branch: BranchIdentity,
  attemptsCeiling: number,
): Promise<ClaimBranchResult> {
  // See claimStage's identical note (stage.ts): throwing INSIDE the transaction callback below
  // would roll back the dead-letter write it just made, so the ceiling branch returns a tagged
  // result and the actual throw happens AFTER commit, outside the transaction.
  const outcome = await db.transaction().execute(async (trx) => {
    await acquireInstanceLock(trx, contract.pipeline, branch.instanceId);

    const existing = await sql`
      SELECT branch_status_id
      FROM ${sql.table(branchTableRef(contract))}
      WHERE ${sql.id(contract.instanceIdColumn)} = ${branch.instanceId}
        AND stage = ${branch.stage}
        AND branch_key = ${branch.branchKey}
    `.execute(trx);
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      throw new NotFoundError(
        `runPipelineBranch: no branch row for (${branch.instanceId}, ${branch.stage}, ${branch.branchKey}) — registerBranches must run before runPipelineBranch`,
      );
    }
    const { branch_status_id: statusId } = rowAs(branchStatusIdRowSchema, existingRow);
    if (statusId === BRANCH_STATUS.Completed.id) {
      return { kind: STAGE_RUN_OUTCOME.ReplayNoOp } as const;
    }
    if (statusId === BRANCH_STATUS.Failed.id) {
      return { kind: STAGE_RUN_OUTCOME.AlreadyFailed } as const;
    }

    const claimed = await sql`
      UPDATE ${sql.table(branchTableRef(contract))}
      SET attempts = attempts + 1
      WHERE ${sql.id(contract.instanceIdColumn)} = ${branch.instanceId}
        AND stage = ${branch.stage}
        AND branch_key = ${branch.branchKey}
        AND branch_status_id = ${BRANCH_STATUS.Pending.id}
      RETURNING attempts
    `.execute(trx);
    const claimedRow = claimed.rows[0];
    if (claimedRow === undefined) {
      throw new InternalError(
        `runPipelineBranch: regression guard matched 0 rows for a branch read as pending moments earlier (${branch.instanceId}, ${branch.stage}, ${branch.branchKey})`,
      );
    }
    const { attempts } = rowAs(attemptsRowSchema, claimedRow);

    if (claimReachedCeiling(attempts, attemptsCeiling)) {
      await writeDeadLetter(trx, contract, {
        instanceId: branch.instanceId,
        stage: branch.stage,
        branchKey: branch.branchKey,
        reason: 'claim: branch attempts ceiling reached',
        attempts,
      });
      return { kind: 'ceiling-reached' as const };
    }

    return { kind: 'claimed' as const, attempts };
  });

  if (outcome.kind === 'ceiling-reached') {
    throw new InternalError(
      `${contract.pipeline}.${branch.stage}:${branch.branchKey}: attempts ceiling reached`,
      { retryable: false },
    );
  }
  if (
    outcome.kind === STAGE_RUN_OUTCOME.ReplayNoOp ||
    outcome.kind === STAGE_RUN_OUTCOME.AlreadyFailed
  ) {
    return { outcome: outcome.kind };
  }
  return { outcome: 'claimed', attempts: outcome.attempts };
}

type CompleteBranchWithApplyResult =
  | { readonly outcome: 'completed'; readonly decision: JoinDecision }
  | { readonly outcome: typeof STAGE_RUN_OUTCOME.AlreadyFailed };

/** The completing transaction for `runPipelineBranch`: advisory lock -> re-check status (a
 * reconciler may have dead-lettered a slow attempt: `Failed` ⇒ rollback, `AlreadyFailed`) ->
 * `applyBeforeComplete(trx)` -> `completeBranchLocked` ("Runs in the completing
 * transaction, BEFORE `completeBranch`'s update in that same transaction"). Cannot reuse the
 * public `completeBranch` directly — that export takes no hook (frozen signature) — so this
 * duplicates its locked-completion core with the hook spliced in before it. */
function completeBranchWithApply(
  db: Kysely<unknown>,
  contract: PipelineTableContract,
  branch: BranchIdentity,
  applyBeforeComplete: (trx: Kysely<unknown>) => Promise<void>,
): Promise<CompleteBranchWithApplyResult> {
  return db.transaction().execute(async (trx) => {
    await acquireInstanceLock(trx, contract.pipeline, branch.instanceId);

    const existing = await sql`
      SELECT branch_status_id
      FROM ${sql.table(branchTableRef(contract))}
      WHERE ${sql.id(contract.instanceIdColumn)} = ${branch.instanceId}
        AND stage = ${branch.stage}
        AND branch_key = ${branch.branchKey}
    `.execute(trx);
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      throw new NotFoundError(
        `runPipelineBranch: no branch row for (${branch.instanceId}, ${branch.stage}, ${branch.branchKey})`,
      );
    }
    const { branch_status_id: statusId } = rowAs(branchStatusIdRowSchema, existingRow);
    if (statusId === BRANCH_STATUS.Failed.id) {
      return { outcome: STAGE_RUN_OUTCOME.AlreadyFailed };
    }

    await applyBeforeComplete(trx);
    const decision = await completeBranchLocked(trx, contract, branch);
    return { outcome: 'completed', decision };
  });
}

export interface BranchRunOptions<TResult> {
  readonly db: Kysely<unknown>;
  readonly contract: PipelineTableContract;
  readonly branch: BranchIdentity;
  readonly attemptsCeiling: number;
  readonly performExternalCall: () => Promise<TResult>;
  readonly resultSchema: z.ZodType<TResult>;
  /** Runs in the completing transaction, BEFORE `completeBranch`'s update in that same
   * transaction. */
  readonly applyResult: (trx: Kysely<unknown>, result: TResult) => Promise<void>;
  /** Fired iff the join decision was `CompletedNow` (outside the transaction, after commit). */
  readonly onJoinCompleted: () => Promise<void>;
}

/** `runPipelineStage`'s shape for one OWNED branch: claim = `attempts++` under the
 * advisory lock with the pending-guard (already-terminal ⇒ `ReplayNoOp`/`AlreadyFailed`),
 * write-ahead token `'{stage}:{branchKey}'`, ceiling ⇒ dead-letter. Returns the stage-run
 * outcome; the join decision is delivered via `onJoinCompleted`. */
export async function runPipelineBranch<TResult>(
  options: BranchRunOptions<TResult>,
): Promise<StageRunOutcome> {
  const claim = await claimBranch(
    options.db,
    options.contract,
    options.branch,
    options.attemptsCeiling,
  );
  if (claim.outcome !== 'claimed') {
    return claim.outcome;
  }

  const attemptToken = `${options.branch.stage}:${options.branch.branchKey}`;
  const existingResult = await readAttemptResult(
    options.db,
    options.contract,
    options.branch.instanceId,
    attemptToken,
    options.resultSchema,
  );

  const result =
    existingResult !== undefined
      ? existingResult
      : await writeAttemptResult(
          options.db,
          options.contract,
          options.branch.instanceId,
          attemptToken,
          options.resultSchema,
          await performExternalCallWithRouting(
            options.db,
            options.contract,
            {
              instanceId: options.branch.instanceId,
              stage: options.branch.stage,
              branchKey: options.branch.branchKey,
              attempts: claim.attempts,
            },
            options.performExternalCall,
          ),
        );

  const completion = await completeBranchWithApply(
    options.db,
    options.contract,
    options.branch,
    (trx) => options.applyResult(trx, result),
  );

  if (completion.outcome === STAGE_RUN_OUTCOME.AlreadyFailed) {
    return STAGE_RUN_OUTCOME.AlreadyFailed;
  }

  if (completion.decision === JOIN_DECISION.CompletedNow) {
    await options.onJoinCompleted();
  }
  return STAGE_RUN_OUTCOME.Completed;
}
