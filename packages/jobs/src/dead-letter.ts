import { BRANCH_STATUS, STAGE_STATUS } from '@repo/entities';
import type { JsonObject } from '@repo/kernel';
import { createModuleObservability, METRIC_ATTRIBUTE } from '@repo/observability';
import { type Kysely, sql } from 'kysely';
import type { PipelineTableContract } from './contract.js';
import { truncateReason } from './internal/reason.js';
import { branchTableRef, instanceTableRef } from './internal/table-refs.js';

const obs = createModuleObservability('jobs');

/**
 * TWO entry points, deliberately, not one:
 *
 * - {@link writeDeadLetter} — a STAGE pipeline dead-letters an INSTANCE. Beyond the shared
 *   `jobs.dead_letter` row, it closes what that pipeline's OWN tables track: it flips
 *   `{stage}_stage_status_id` on the instance row and fails every still-`Pending` branch of
 *   `(instance, stage)` in that pipeline's branch table (ADR-0007: "closes remaining open
 *   branches in the same transaction"). It needs a full `PipelineTableContract` for exactly that
 *   reason — it has to know the instance table, the branch table, and the `{stage}_stage_status_id`
 *   column name to update them, and neither exists for an outbox.
 * - {@link writeOutboxDeadLetter} — an OUTBOX pipeline (`relayOutboxBatch`, SPEC-0004)
 *   dead-letters a ROW, not an instance. An outbox row has no stage-status column and no branch
 *   table to close — parking IS its terminal state, held entirely in the row's own
 *   `outbox_row_status_id` — so this writes ONLY the shared `jobs.dead_letter` row. It takes no
 *   `PipelineTableContract` because there is no sibling table shape to interpret: a bare pipeline
 *   name, instance id, stage, reason and attempts count are the whole of what an outbox row has to
 *   report.
 *
 * Both share the same `jobs.dead_letter` conflict target, the same `truncateReason`, the same
 * boundary `error`-log discipline, and the same `jobs.dead-letter.write` counter — a dead-lettered
 * row is exactly as visible to triage regardless of which pipeline shape produced it.
 */

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

// ---------------------------------------------------------------------------------------------
// writeOutboxDeadLetter (SPEC-0004) — see this file's header for why this is a separate function
// rather than a `writeDeadLetter` call site.
// ---------------------------------------------------------------------------------------------

/** Matches what Postgres's `uuid` column type accepts (any RFC 4122 layout, permissive about the
 * version/variant nibbles — this is a defensive parse guarding an INSERT, not a uuid minter). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A dead-letter record for an OUTBOX pipeline (see this file's header). No `branchKey` — an
 * outbox row has no branches — and no `PipelineTableContract`: `pipeline` travels explicitly
 * because there is no contract to read it from. */
export interface OutboxDeadLetterRecord {
  readonly pipeline: string;
  readonly instanceId: string;
  readonly stage: string;
  /** Truncated to `REASON_MAX_LENGTH` here, same as {@link DeadLetterRecord.reason}. */
  readonly reason: string;
  readonly attempts: number;
}

/**
 * Writes ONLY the `jobs.dead_letter` row for a parked outbox row (SPEC-0004) — no instance-table
 * update, no branch-table update, because an outbox row has neither (see this file's header).
 * Takes a bare `Kysely<unknown>` executor rather than branching on `db.isTransaction` the way
 * {@link writeDeadLetter} does: this function's only caller (`relayOutboxBatch`, `src/outbox.ts`)
 * always passes its own already-open claim transaction, so the park and this triage row commit
 * together by construction — that atomicity is the entire reason this write lives in the spine
 * instead of at a composition root.
 *
 * ONE HAZARD THIS FUNCTION EXISTS TO ABSORB, read before touching: `jobs.dead_letter.instance_id`
 * is `uuid NOT NULL`, while an `OutboxTableRef`'s `aggregate_id` column is merely `text`. Every
 * aggregate id this system's one outbox (`reviews.outbox`) ever carries is a uuid, but nothing in
 * `OutboxTableRef` enforces that for some future outbox, and a failed statement aborts the WHOLE
 * enclosing Postgres transaction — which here is the relay's own claim transaction, so a bad
 * `instanceId` would roll back the park itself along with this row, leaving a poison row to retry
 * forever. That is strictly worse than a missing triage record: parking must never be at the
 * mercy of its own triage record. So the uuid shape is checked BEFORE the INSERT is attempted; a
 * non-uuid `instanceId` logs one `warn` naming the pipeline, stage and instance id and returns
 * having touched the database not at all — this looks like defensive noise for a system with
 * exactly one, uuid-keyed outbox, until the day it is not.
 */
export async function writeOutboxDeadLetter(
  db: Kysely<unknown>,
  record: OutboxDeadLetterRecord,
): Promise<void> {
  if (!UUID_RE.test(record.instanceId)) {
    obs.logger.warn(
      { pipeline: record.pipeline, stage: record.stage, instanceId: record.instanceId },
      `${record.pipeline}.${record.stage}: outbox row's aggregate id is not a uuid — ` +
        'jobs.dead_letter.instance_id is uuid NOT NULL, so no triage row was written for it; the row still parks',
    );
    return;
  }

  const reason = truncateReason(record.reason);
  await sql`
    INSERT INTO jobs.dead_letter (pipeline, instance_id, stage, reason, attempts)
    VALUES (${record.pipeline}, ${record.instanceId}, ${record.stage}, ${reason}, ${record.attempts})
    ON CONFLICT ON CONSTRAINT uq_dead_letter__pipeline_instance_id_stage_branch_key DO NOTHING
  `.execute(db);

  obs.logger.error(
    {
      pipeline: record.pipeline,
      stage: record.stage,
      instanceId: record.instanceId,
      attempts: record.attempts,
      reason,
    },
    `${record.pipeline}.${record.stage}: outbox row dead-lettered`,
  );
  deadLetterWriteCounter.add(1, { stage: record.stage });
}
