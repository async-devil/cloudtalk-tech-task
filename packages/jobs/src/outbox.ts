import { OUTBOX_ROW_STATUS } from '@repo/entities';
import { describeError, type JsonObject, type JsonValue } from '@repo/kernel';
import {
  createWorker,
  type MessagingConnection,
  scheduleRepeatable,
  type WorkerHandle,
} from '@repo/messaging';
import { createModuleObservability, METRIC_ATTRIBUTE } from '@repo/observability';
import { rowAs, rowsAs } from '@repo/persistence';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { writeOutboxDeadLetter } from './dead-letter.js';
import { toSegment } from './internal/identifiers.js';
import { truncateReason } from './internal/reason.js';
import { jsonValueSchema, oldestCreatedAtRowSchema } from './internal/rows.js';
import { tickSchema } from './internal/tick.js';
import type { ScheduledWorkerHandle } from './scheduled-worker.js';

const obs = createModuleObservability('jobs');

/**
 * The outbox relay row outcome vocabulary, as a const-object value set
 * (ADR-0003).
 */
export const OUTBOX_ROW_OUTCOME = {
  Processed: 'processed',
  Failed: 'failed',
  Parked: 'parked',
} as const;
export type OutboxRowOutcome = (typeof OUTBOX_ROW_OUTCOME)[keyof typeof OUTBOX_ROW_OUTCOME];

/** `jobs.outbox.run`: counter incremented once per pass. */
export const OUTBOX_RUN_INSTRUMENT = {
  name: 'jobs.outbox.run',
  allowedAttributes: [METRIC_ATTRIBUTE.Queue],
} as const;
const outboxRunCounter = obs.createCounter(OUTBOX_RUN_INSTRUMENT);

/** `jobs.outbox.relay`: counter incremented once per row processed. */
export const OUTBOX_RELAY_INSTRUMENT = {
  name: 'jobs.outbox.relay',
  allowedAttributes: [METRIC_ATTRIBUTE.Queue, METRIC_ATTRIBUTE.Outcome],
} as const;
const outboxRelayCounter = obs.createCounter(OUTBOX_RELAY_INSTRUMENT);

/** `jobs.outbox.backlog`: histogram recording age of oldest pending row. */
export const OUTBOX_BACKLOG_INSTRUMENT = {
  name: 'jobs.outbox.backlog',
  unit: 'ms',
  allowedAttributes: [METRIC_ATTRIBUTE.Queue],
} as const;
const outboxBacklogHistogram = obs.createHistogram(OUTBOX_BACKLOG_INSTRUMENT);

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_MAX_ATTEMPTS = 5;

/**
 * Every outbox lives in its owning context's schema and is named `outbox`, so a bare
 * table string can no longer address one.
 */
export interface OutboxTableRef {
  readonly schema: string;
  /** Frozen as `'outbox'` for every context; carried explicitly so the spine never
   * string-builds a qualified name, and so a context with a second outbox stays expressible. */
  readonly table: string;
}

function outboxTableName(outbox: OutboxTableRef): string {
  return `${outbox.schema}.${outbox.table}`;
}

/** The relay's own stage segment — ONE formula, shared by `relayOutboxBatch`'s parking branch
 * (the `jobs.dead_letter.stage` value) and `startOutboxRelay`'s worker/schedule registration, so
 * the two can never drift apart into naming two different things "the relay's stage". */
function outboxRelayStage(outbox: OutboxTableRef): string {
  return `${toSegment(outbox.schema)}-outbox-relay`;
}

// ---------------------------------------------------------------------------------------------
// insertOutboxRows
// ---------------------------------------------------------------------------------------------

export interface OutboxInsert {
  readonly aggregateId: string;
  readonly op: string;
  readonly payload: JsonObject;
}

/** Rows per multi-row INSERT. Postgres caps a statement at 65535 bind parameters; at 3 params per
 * row the hard ceiling is ~21k, so 1000 leaves generous headroom while collapsing a large rebuild
 * from N round-trips to ⌈N/1000⌉. */
const OUTBOX_INSERT_CHUNK = 1000;

/** Producer side — called ONLY inside the same transaction as the canonical write (ADR-0007);
 * `trx` being the completing transaction is the mechanism. Batched into chunked multi-row INSERTs
 *: `rebuildProjection` passes one row per completed item, so a per-row loop was N
 * serial round-trips inside one transaction. */
export async function insertOutboxRows(
  trx: Kysely<unknown>,
  outbox: OutboxTableRef,
  rows: ReadonlyArray<OutboxInsert>,
): Promise<void> {
  const table = sql.table(outboxTableName(outbox));
  for (let start = 0; start < rows.length; start += OUTBOX_INSERT_CHUNK) {
    const chunk = rows.slice(start, start + OUTBOX_INSERT_CHUNK);
    const values = chunk.map(
      (row) => sql`(${row.aggregateId}, ${row.op}, ${JSON.stringify(row.payload)}::jsonb)`,
    );
    await sql`
      INSERT INTO ${table} (aggregate_id, op, payload)
      VALUES ${sql.join(values, sql`, `)}
    `.execute(trx);
  }
}

// ---------------------------------------------------------------------------------------------
// relayOutboxBatch (ADR-0007)
// ---------------------------------------------------------------------------------------------

export interface OutboxRow {
  /** `outbox_id`; bigserial travels as string (pg int8). */
  readonly outboxId: string;
  readonly aggregateId: string;
  readonly op: string;
  readonly payload: JsonValue;
  readonly attempts: number;
  /** When this row was inserted (its producer's transaction commit) — additive (TASK-0005):
   * `reviews.rating.lag` needs it to measure ms from event creation to the recomputation that
   * applies it, and the claim below already reads this row past `created_at` for the backlog-age
   * query, so surfacing it here costs nothing beyond the `SELECT` column. */
  readonly createdAt: Date;
}

const outboxClaimRowSchema = z.object({
  outbox_id: z.string(),
  aggregate_id: z.string(),
  op: z.string(),
  payload: jsonValueSchema,
  attempts: z.number().int(),
  created_at: z.date(),
});

export interface OutboxRelayOptions {
  readonly db: Kysely<unknown>;
  readonly outbox: OutboxTableRef;
  /** MUST be idempotent (MERGE/upsert semantics) — at-least-once replay is the contract. */
  readonly apply: (row: OutboxRow) => Promise<void>;
  /** @default 50 */
  readonly batchSize?: number;
  /** Park (`status = 'dead'`) when a row's attempts reach this. @default 5 */
  readonly maxAttempts?: number;
  /** `jobs.dead_letter.pipeline` for a row this relay parks (SPEC-0004: "a `jobs.dead_letter` row
   * is written for triage (pipeline `reviews`...)"). @default `outbox.schema` — right for every
   * outbox this system has today, since each bounded context owns exactly one outbox named after
   * its own schema; override when a pipeline name must differ from the schema that owns it. */
  readonly pipeline?: string;
}

export interface OutboxRelayReport {
  readonly claimed: number;
  readonly processed: number;
  readonly failed: number;
  readonly parked: number;
  /** ms age of the oldest unprocessed row at pass START; undefined when the backlog is empty. */
  readonly oldestPendingAgeMs?: number;
}

/** ms age of `oldestCreatedAt` relative to `now` — extracted as a pure function ("report math",
 * 's unit-test scope) so the backlog histogram's input is directly unit-testable
 * without a database. */
export function computeOldestPendingAgeMs(oldestCreatedAt: Date, now: Date): number {
  return Math.max(0, now.getTime() - oldestCreatedAt.getTime());
}

/**
 * ONE transaction per pass (ADR-0007, frozen mechanics — the claim and the marks speak the
 * ADR-0011 vocabulary): `SELECT ... WHERE outbox_row_status_id = Pending ORDER BY outbox_id
 * FOR UPDATE SKIP LOCKED LIMIT batchSize`, then per row an isolated `try/catch` around `apply`:
 * success ⇒ `Processed` + `processed_at = now()`; throw ⇒ `attempts++`, `last_error`, and `Dead`
 * once `attempts >= maxAttempts` (one `warn` log per newly-parked row, plus a `jobs.dead_letter`
 * triage row via `writeOutboxDeadLetter` — SPEC-0004 — written in this SAME transaction so parking
 * and its triage record commit together). The single commit lands ALL per-row marks — successes
 * commit even when siblings fail; a poison row wedges only itself. Per-row failures are handled
 * HERE and never rethrown (ADR-0008: this is the handling boundary).
 */
export function relayOutboxBatch(options: OutboxRelayOptions): Promise<OutboxRelayReport> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const tableName = outboxTableName(options.outbox);
  // Needed only by the parking branch below, but computed once per pass rather than per row —
  // neither depends on the claimed row.
  const stage = outboxRelayStage(options.outbox);
  const pipeline = options.pipeline ?? options.outbox.schema;

  return options.db.transaction().execute(async (trx) => {
    const oldestPending = await sql`
      SELECT created_at FROM ${sql.table(tableName)}
      WHERE outbox_row_status_id = ${OUTBOX_ROW_STATUS.Pending.id}
      ORDER BY outbox_id ASC
      LIMIT 1
    `.execute(trx);
    const oldestRow = oldestPending.rows[0];
    const oldestPendingAgeMs =
      oldestRow !== undefined
        ? computeOldestPendingAgeMs(
            rowAs(oldestCreatedAtRowSchema, oldestRow).created_at,
            new Date(),
          )
        : undefined;

    const claimedResult = await sql`
      SELECT outbox_id, aggregate_id, op, payload, attempts, created_at
      FROM ${sql.table(tableName)}
      WHERE outbox_row_status_id = ${OUTBOX_ROW_STATUS.Pending.id}
      ORDER BY outbox_id
      FOR UPDATE SKIP LOCKED
      LIMIT ${batchSize}
    `.execute(trx);
    const claimed = rowsAs(outboxClaimRowSchema, claimedResult.rows);

    // Record the run once per pass, even when empty
    outboxRunCounter.add(1, { queue: tableName });

    let processed = 0;
    let failed = 0;
    let parked = 0;

    for (const row of claimed) {
      try {
        await options.apply({
          outboxId: row.outbox_id,
          aggregateId: row.aggregate_id,
          op: row.op,
          payload: row.payload,
          attempts: row.attempts,
          createdAt: row.created_at,
        });
        await sql`
          UPDATE ${sql.table(tableName)}
          SET outbox_row_status_id = ${OUTBOX_ROW_STATUS.Processed.id}, processed_at = now()
          WHERE outbox_id = ${row.outbox_id}
        `.execute(trx);
        processed += 1;
        outboxRelayCounter.add(1, { queue: tableName, outcome: OUTBOX_ROW_OUTCOME.Processed });
      } catch (error) {
        const newAttempts = row.attempts + 1;
        const lastError = truncateReason(describeError(error));
        if (newAttempts >= maxAttempts) {
          await sql`
            UPDATE ${sql.table(tableName)}
            SET attempts = ${newAttempts},
                last_error = ${lastError},
                outbox_row_status_id = ${OUTBOX_ROW_STATUS.Dead.id}
            WHERE outbox_id = ${row.outbox_id}
          `.execute(trx);
          // SPEC-0004: a parked row gets a `jobs.dead_letter` row for triage. Written HERE, inside
          // `trx` — the same claim transaction that just marked the row `Dead` above — so parking
          // and its triage record commit together (`writeOutboxDeadLetter`'s own doc has the uuid
          // hazard this call is safe against: a non-uuid `aggregate_id` cannot make this statement
          // throw and abort the park with it).
          await writeOutboxDeadLetter(trx, {
            pipeline,
            instanceId: row.aggregate_id,
            stage,
            reason: lastError,
            attempts: newAttempts,
          });
          parked += 1;
          outboxRelayCounter.add(1, { queue: tableName, outcome: OUTBOX_ROW_OUTCOME.Parked });
          obs.logger.warn(
            {
              outbox: tableName,
              outboxId: row.outbox_id,
              attempts: newAttempts,
              reason: lastError,
            },
            'relayOutboxBatch: row parked at max attempts',
          );
        } else {
          await sql`
            UPDATE ${sql.table(tableName)}
            SET attempts = ${newAttempts}, last_error = ${lastError}
            WHERE outbox_id = ${row.outbox_id}
          `.execute(trx);
          failed += 1;
          outboxRelayCounter.add(1, { queue: tableName, outcome: OUTBOX_ROW_OUTCOME.Failed });
        }
      }
    }

    // Record backlog histogram only when there are pending rows
    if (oldestPendingAgeMs !== undefined) {
      outboxBacklogHistogram.record(oldestPendingAgeMs, { queue: tableName });
    }

    return {
      claimed: claimed.length,
      processed,
      failed,
      parked,
      ...(oldestPendingAgeMs !== undefined ? { oldestPendingAgeMs } : {}),
    };
  });
}

/**
 * Repeatable wiring: `scheduleRepeatable` (schedulerId
 * `outbox-relay:{schema}.{table}`) + a worker whose handler is `relayOutboxBatch`. `stage` and this
 * worker's own `pipeline` (`@repo/messaging`'s job-routing segment, `createWorker`'s `pipeline`
 * argument below — NOT `OutboxRelayOptions.pipeline`, the unrelated `jobs.dead_letter.pipeline`
 * value `relayOutboxBatch` defaults from the same schema) are both run through `toSegment`
 * (ADR-0009's `assertSegment` rejects the underscores an ADR-0011 schema name like
 * `example_context` legitimately contains — see the identifiers module doc); the dead-letter
 * pipeline value is deliberately NOT segment-transliterated, since `jobs.dead_letter.pipeline` is
 * a plain ADR-0011 identifier column, not a `{module}.{object}.{verb}` segment. Returns the worker
 * handle for shutdown.
 */
export async function startOutboxRelay(
  options: OutboxRelayOptions & {
    readonly connection: MessagingConnection;
    readonly everyMs: number;
  },
): Promise<ScheduledWorkerHandle> {
  const schemaSegment = toSegment(options.outbox.schema);
  const stage = outboxRelayStage(options.outbox);

  // Hoisted so the schedule registration below and the returned handle name ONE declaration
  //: a consumer probing whether this schedule exists in Redis must read the
  // id we actually registered, never a second copy of the formula.
  const schedulerId = `outbox-relay:${options.outbox.schema}.${options.outbox.table}`;
  await scheduleRepeatable({
    stage,
    connection: options.connection,
    schedulerId,
    every: { milliseconds: options.everyMs },
    data: {},
  });

  const worker: WorkerHandle = createWorker({
    stage,
    pipeline: schemaSegment,
    connection: options.connection,
    schema: tickSchema,
    handler: async () => {
      await relayOutboxBatch(options);
    },
  });

  return { ...worker, schedulerId, stage };
}
