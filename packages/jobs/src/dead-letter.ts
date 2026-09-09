import { BRANCH_STATUS, STAGE_STATUS } from '@repo/entities';
import type { JsonObject } from '@repo/kernel';
import { createModuleObservability, METRIC_ATTRIBUTE } from '@repo/observability';
import { type Kysely, sql } from 'kysely';
import type { PipelineTableContract } from './contract.js';
import { truncateReason } from './internal/reason.js';
import { branchTableRef, instanceTableRef } from './internal/table-refs.js';

const obs = createModuleObservability('jobs');

/**
 * `jobs.dead-letter.write`: counter incremented once per write. Dashed rather than
 * `dead_letter`, and the reason is mechanical: `assertModuleName` (ADR-0009) requires every
 * `{module}.{object}.{verb}` segment to match `[a-z0-9-]+`, so an underscore throws
 * `ValidationError` at `createCounter` construction time rather than at first emission. Same naming-domain collision as the relay/reconciler/
 * retention stage names (`internal/identifiers.ts`'s `toSegment` doc) — ADR-0011's DB-identifier
 * snake_case and ADR-0009's span/instrument kebab-case disagree on the word separator. Dashed
 * (`dead-letter`) rather than concatenated (`deadletter`), matching `toSegment`'s own choice, so
 * the word boundary stays legible.
 */
export const DEAD_LETTER_WRITE_INSTRUMENT = {
  name: 'jobs.dead-letter.write',
  allowedAttributes: [METRIC_ATTRIBUTE.Stage],
} as const;
const deadLetterWriteCounter = obs.createCounter(DEAD_LETTER_WRITE_INSTRUMENT);

/** A dead-letter record (frozen). */
export interface DeadLetterRecord {
  readonly instanceId: string;
  readonly stage: string;
  readonly branchKey?: string;
  /** Non-empty by construction: callers pass `describeError(error)` or
   * `classifyRetry(error).reason` — kernel guarantees the fallback chain (ADR-0007). Never a raw
   * provider body (ADR-0006); truncated to `REASON_MAX_LENGTH` characters here regardless. */
  readonly reason: string;
  readonly attempts: number;
  /** Identifiers and classification only — see `jobs.dead_letter.payload`'s column comment
   * (ADR-0006). */
  readonly payload?: JsonObject;
}

/**
 * In ONE transaction (the caller's `db`, when it is already a `Transaction`, or a fresh one
 * otherwise — `db.isTransaction` is the switch): insert the dead-letter row (`ON CONFLICT DO
 * NOTHING` on the pipeline/instance/stage/branch-key key — replay-safe), set
 * `{stage}_stage_status_id = Failed`, and close every still-`Pending` branch of
 * `(instanceId, stage)` as `Failed` with the same reason (ADR-0007: "closes remaining open
 * branches in the same transaction" — this includes the very branch that triggered the write,
 * which is itself still `Pending` at this point). Emits the one boundary `error` log (ADR-0008
 * handle-once: the error's journey ends in this row) and the `jobs.dead-letter.write` counter.
 */
export async function writeDeadLetter(
  db: Kysely<unknown>,
  contract: PipelineTableContract,
  record: DeadLetterRecord,
): Promise<void> {
  const run = async (trx: Kysely<unknown>): Promise<void> => {
    const reason = truncateReason(record.reason);
    const statusColumn = `${record.stage}_stage_status_id`;
    const updatedAtColumn = `${record.stage}_updated_at`;

    await sql`
      INSERT INTO jobs.dead_letter (pipeline, instance_id, stage, branch_key, reason, attempts, payload)
      VALUES (
        ${contract.pipeline},
        ${record.instanceId},
        ${record.stage},
        ${record.branchKey ?? null},
        ${reason},
        ${record.attempts},
        ${record.payload !== undefined ? JSON.stringify(record.payload) : null}::jsonb
      )
      ON CONFLICT ON CONSTRAINT uq_dead_letter__pipeline_instance_id_stage_branch_key DO NOTHING
    `.execute(trx);

    await sql`
      UPDATE ${sql.table(instanceTableRef(contract))}
      SET ${sql.id(statusColumn)} = ${STAGE_STATUS.Failed.id},
          ${sql.id(updatedAtColumn)} = now()
      WHERE ${sql.id(contract.instanceIdColumn)} = ${record.instanceId}
    `.execute(trx);

    await sql`
      UPDATE ${sql.table(branchTableRef(contract))}
      SET branch_status_id = ${BRANCH_STATUS.Failed.id}, last_error = ${reason}
      WHERE ${sql.id(contract.instanceIdColumn)} = ${record.instanceId}
        AND stage = ${record.stage}
        AND branch_status_id = ${BRANCH_STATUS.Pending.id}
    `.execute(trx);

    obs.logger.error(
      {
        pipeline: contract.pipeline,
        stage: record.stage,
        instanceId: record.instanceId,
        branchKey: record.branchKey,
        attempts: record.attempts,
        reason,
      },
      `${contract.pipeline}.${record.stage}: pipeline instance dead-lettered`,
    );
    deadLetterWriteCounter.add(1, { stage: record.stage });
  };

  if (db.isTransaction) {
    await run(db);
  } else {
    await db.transaction().execute(run);
  }
}
