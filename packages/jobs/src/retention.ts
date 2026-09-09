import { OUTBOX_ROW_STATUS } from '@repo/entities';
import { ValidationError } from '@repo/kernel';
import { createWorker, type MessagingConnection, scheduleRepeatable } from '@repo/messaging';
import { createModuleObservability, METRIC_ATTRIBUTE } from '@repo/observability';
import { type Kysely, type RawBuilder, sql } from 'kysely';
import type { PipelineTableContract } from './contract.js';
import { toSegment } from './internal/identifiers.js';
import { stageResultTableRef } from './internal/table-refs.js';
import { tickSchema } from './internal/tick.js';
import type { OutboxTableRef } from './outbox.js';
import type { ScheduledWorkerHandle } from './scheduled-worker.js';

const obs = createModuleObservability('jobs');

/**
 * The retention purge target outcome vocabulary, as a const-object value set
 * (ADR-0003).
 */
export const RETENTION_PURGE_TARGET = {
  StageResult: 'stage_result',
  OutboxProcessed: 'outbox_processed',
  OutboxDead: 'outbox_dead',
  DeadLetter: 'dead_letter',
} as const;
export type RetentionPurgeTarget =
  (typeof RETENTION_PURGE_TARGET)[keyof typeof RETENTION_PURGE_TARGET];

/** `jobs.retention.run`: counter incremented once per retention pass. */
export const RETENTION_RUN_INSTRUMENT = {
  name: 'jobs.retention.run',
  allowedAttributes: [METRIC_ATTRIBUTE.Queue],
} as const;
const retentionRunCounter = obs.createCounter(RETENTION_RUN_INSTRUMENT);

/** `jobs.retention.purged`: counter incremented per purge target with count of rows purged. */
export const RETENTION_PURGED_INSTRUMENT = {
  name: 'jobs.retention.purged',
  allowedAttributes: [METRIC_ATTRIBUTE.Queue, METRIC_ATTRIBUTE.Outcome],
} as const;
const retentionPurgedCounter = obs.createCounter(RETENTION_PURGED_INSTRUMENT);

const DEFAULT_RETENTION_BATCH_SIZE = 500;

/**
 * [ADR-0006] Retention knobs for one pipeline. Deliberately its own options object rather
 * than a field on `PipelineTableContract` — the contract rides every hot-path claim/complete;
 * `ReconcilerOptions` already established that operational knobs (`staleAfterMs`,
 * `attemptsCeiling`) ride an options object a scheduled job reads, and retention follows that
 * precedent.
 */
export interface RetentionOptions {
  readonly db: Kysely<unknown>;
  readonly contract: PipelineTableContract;
  /** Present iff this pipeline has an outbox to maintain. */
  readonly outbox?: OutboxTableRef;
  /** Purge `{table}_stage_result` rows older than this. MUST exceed `staleAfterMs`. */
  readonly stageResultRetainMs: number;
  /** Purge outbox rows at `OUTBOX_ROW_STATUS.Processed` older than this. Required when `outbox`
   * is set. */
  readonly processedOutboxRetainMs?: number;
  /** Purge outbox rows at `OUTBOX_ROW_STATUS.Dead` older than this — the triage window for
   * parked rows; typically longer than the processed horizon. Required when `outbox` is set. */
  readonly deadOutboxRetainMs?: number;
  /** The same value the reconciler receives — the floor every horizon is validated against. */
  readonly staleAfterMs: number;
  /** Rows deleted per statement per pass (bounded passes, no long-held locks). @default 500 */
  readonly batchSize?: number;
}

export interface RetentionReport {
  readonly stageResultsPurged: number;
  readonly outboxProcessedPurged: number;
  readonly outboxDeadPurged: number;
}

/**
 * The ADR-0006 floor: a stage-result row is unreachable by the spine once its stage is
 * terminal, so retention length is an ops choice — EXCEPT that an attempt still in flight reads
 * the write-ahead row to skip the paid call, and a purge inside that window makes it re-bill.
 * `staleAfterMs` already bounds that window, so every horizon must exceed it.
 */
function assertHorizonExceedsStaleAfter(
  retainMs: number,
  staleAfterMs: number,
  label: string,
): void {
  if (retainMs <= staleAfterMs) {
    throw new ValidationError(
      `${label} (${retainMs}ms) must exceed staleAfterMs (${staleAfterMs}ms) — a purge inside the in-flight window would re-bill the provider (ADR-0006)`,
    );
  }
}

function validateRetentionOptions(options: RetentionOptions): void {
  assertHorizonExceedsStaleAfter(
    options.stageResultRetainMs,
    options.staleAfterMs,
    'stageResultRetainMs',
  );
  if (options.outbox !== undefined) {
    if (options.processedOutboxRetainMs === undefined) {
      throw new ValidationError('processedOutboxRetainMs is required when outbox is set');
    }
    if (options.deadOutboxRetainMs === undefined) {
      throw new ValidationError('deadOutboxRetainMs is required when outbox is set');
    }
    assertHorizonExceedsStaleAfter(
      options.processedOutboxRetainMs,
      options.staleAfterMs,
      'processedOutboxRetainMs',
    );
    assertHorizonExceedsStaleAfter(
      options.deadOutboxRetainMs,
      options.staleAfterMs,
      'deadOutboxRetainMs',
    );
  }
}

/** Bounded-batch delete: repeats `DELETE ... WHERE ctid = ANY(ARRAY(SELECT ctid ... LIMIT
 * batchSize))` until a pass deletes fewer than `batchSize` rows — no single statement holds a
 * long-running lock over an unbounded row set. */
async function batchedDelete(
  db: Kysely<unknown>,
  tableRef: string,
  wherePredicate: RawBuilder<unknown>,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (;;) {
    const result = await sql`
      DELETE FROM ${sql.table(tableRef)}
      WHERE ctid = ANY (ARRAY(
        SELECT ctid FROM ${sql.table(tableRef)}
        WHERE ${wherePredicate}
        LIMIT ${batchSize}
      ))
    `.execute(db);
    const deleted = Number(result.numAffectedRows ?? 0n);
    total += deleted;
    if (deleted < batchSize) {
      break;
    }
  }
  return total;
}

/**
 * One retention pass. Age predicate is `created_at`; the outbox status predicate is
 * the ADR-0011 truth column (`outbox_row_status_id`), ids bound from the `@repo/entities`
 * const — `processed_at` is evidence and is never filtered on. `Pending` outbox rows are never
 * touched. Throws `ValidationError` at the START, before touching the database, when ANY horizon
 * `<= staleAfterMs`.
 */
export async function purgePipelineData(options: RetentionOptions): Promise<RetentionReport> {
  validateRetentionOptions(options);
  const batchSize = options.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;

  // Record the run once per pass, unconditionally
  retentionRunCounter.add(1, { queue: options.contract.pipeline });

  const stageResultsPurged = await batchedDelete(
    options.db,
    stageResultTableRef(options.contract),
    sql`created_at < now() - make_interval(secs => ${options.stageResultRetainMs / 1000})`,
    batchSize,
  );

  let outboxProcessedPurged = 0;
  let outboxDeadPurged = 0;

  if (options.outbox !== undefined) {
    const { processedOutboxRetainMs, deadOutboxRetainMs } = options;
    if (processedOutboxRetainMs === undefined || deadOutboxRetainMs === undefined) {
      // Unreachable: validateRetentionOptions already enforced these are present when `outbox`
      // is set. Kept as a narrowing guard, not new validation.
      throw new ValidationError(
        'processedOutboxRetainMs/deadOutboxRetainMs are required when outbox is set',
      );
    }
    const outboxTableName = `${options.outbox.schema}.${options.outbox.table}`;

    outboxProcessedPurged = await batchedDelete(
      options.db,
      outboxTableName,
      sql`outbox_row_status_id = ${OUTBOX_ROW_STATUS.Processed.id} AND created_at < now() - make_interval(secs => ${processedOutboxRetainMs / 1000})`,
      batchSize,
    );
    outboxDeadPurged = await batchedDelete(
      options.db,
      outboxTableName,
      sql`outbox_row_status_id = ${OUTBOX_ROW_STATUS.Dead.id} AND created_at < now() - make_interval(secs => ${deadOutboxRetainMs / 1000})`,
      batchSize,
    );
  }

  // Record purged counts for each target
  retentionPurgedCounter.add(stageResultsPurged, {
    queue: options.contract.pipeline,
    outcome: RETENTION_PURGE_TARGET.StageResult,
  });
  retentionPurgedCounter.add(outboxProcessedPurged, {
    queue: options.contract.pipeline,
    outcome: RETENTION_PURGE_TARGET.OutboxProcessed,
  });
  retentionPurgedCounter.add(outboxDeadPurged, {
    queue: options.contract.pipeline,
    outcome: RETENTION_PURGE_TARGET.OutboxDead,
  });

  return { stageResultsPurged, outboxProcessedPurged, outboxDeadPurged };
}

/** Repeatable wiring, same shape as the relay/reconciler: schedulerId `retention:{pipeline}`,
 * stage `{pipeline}_retention`. `stage`/`pipeline` are run through `toSegment` (ADR-0009's
 * `assertSegment` rejects the underscores ADR-0011's pipeline-identifier rule legally permits).
 * Validates (and can throw `ValidationError`) BEFORE registering the schedule. */
export async function startRetention(
  options: RetentionOptions & {
    readonly connection: MessagingConnection;
    readonly everyMs: number;
  },
): Promise<ScheduledWorkerHandle> {
  validateRetentionOptions(options);
  const pipelineSegment = toSegment(options.contract.pipeline);
  const stage = `${pipelineSegment}-retention`;

  // Hoisted so the schedule registration below and the returned handle name ONE declaration
  //: a consumer probing whether this schedule exists in Redis must read the
  // id we actually registered, never a second copy of the formula.
  const schedulerId = `retention:${options.contract.pipeline}`;
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
      await purgePipelineData(options);
    },
  });

  return { ...worker, schedulerId, stage };
}

/**
 * [ADR-0006] jobs-owned (the table is jobs' own DDL — ADR-0006 owner-only): per-pipeline
 * dead-letter horizon, `DELETE WHERE pipeline = $1 AND created_at < now() - retainMs`, batched.
 * Each pipeline's composition root registers its own; the same `ValidationError` floor applies.
 * Returns rows purged.
 */
export interface PurgeDeadLettersOptions {
  readonly db: Kysely<unknown>;
  readonly pipeline: string;
  readonly retainMs: number;
  readonly staleAfterMs: number;
  readonly batchSize?: number;
}

export async function purgeDeadLetters(options: PurgeDeadLettersOptions): Promise<number> {
  // Declared `async` deliberately (not a bare pass-through like readStageResult/writeStageResult
  // above): assertHorizonExceedsStaleAfter throws SYNCHRONOUSLY, and only an `async` function
  // guarantees that throw becomes a rejected promise rather than a synchronous exception out of
  // a function typed `Promise<number>` — the ADR-0006 floor must always reject, never throw.
  assertHorizonExceedsStaleAfter(options.retainMs, options.staleAfterMs, 'retainMs');
  const batchSize = options.batchSize ?? DEFAULT_RETENTION_BATCH_SIZE;

  const purgedCount = await batchedDelete(
    options.db,
    'jobs.dead_letter',
    sql`pipeline = ${options.pipeline} AND created_at < now() - make_interval(secs => ${options.retainMs / 1000})`,
    batchSize,
  );

  // Record dead-letter purge count
  retentionPurgedCounter.add(purgedCount, {
    queue: options.pipeline,
    outcome: RETENTION_PURGE_TARGET.DeadLetter,
  });

  return purgedCount;
}
