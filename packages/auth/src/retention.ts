import { ValidationError } from '@repo/kernel';
import { createWorker, type MessagingConnection, scheduleRepeatable } from '@repo/messaging';
import { type Kysely, sql } from 'kysely';
import { z } from 'zod';
import { AUTH_OUTCOME, observability, retentionPurgedCounter } from './internal/observability.js';

/** Job stage for the retention worker. Named
 * `auth_retention` — SPEC DEVIATION, reported: `@repo/observability`'s `withJobStageSpan` rejects
 * underscores (`NAME_SEGMENT_RE = /^[a-z0-9-]+$/`), so the underscore-joined form can never
 * construct — `-` in place of `_`; same meaning. */
const AUTH_RETENTION_STAGE = 'auth-retention';
const DEFAULT_BATCH_SIZE = 1_000;
/** Guard so a mis-set horizon can never spin forever: batches * cap = the most rows one pass moves. */
const MAX_BATCHES_PER_PASS = 10_000;

const emptyJobDataSchema = z.object({});

/** Result of one {@link purgeExpiredAuthRows} pass. */
export interface AuthPurgeResult {
  readonly sessionsPurged: number;
  readonly verificationsPurged: number;
}

/**
 * One retention pass: DELETE `auth.session` rows older than
 * `sessionRetainMs` past their expiry, and consumed/expired `auth.verification` rows older than
 * `verificationRetainMs`. Bounded batches. Floors: both horizons must be `> 0` (a non-positive
 * horizon would purge live rows — `ValidationError`); the `expires_at <` predicate additionally
 * guarantees a verification row is never purged before it expires.
 */
export async function purgeExpiredAuthRows(options: {
  readonly db: Kysely<unknown>;
  readonly sessionRetainMs: number;
  readonly verificationRetainMs: number;
  readonly batchSize?: number;
}): Promise<AuthPurgeResult> {
  if (options.sessionRetainMs <= 0) {
    throw new ValidationError('sessionRetainMs must be > 0', {
      details: { sessionRetainMs: options.sessionRetainMs },
    });
  }
  if (options.verificationRetainMs <= 0) {
    throw new ValidationError('verificationRetainMs must be > 0', {
      details: { verificationRetainMs: options.verificationRetainMs },
    });
  }
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;

  return await observability.withSpan('auth.retention.run', async (span) => {
    const sessionsPurged = await purgeBatches(
      options.db,
      'session',
      'id',
      options.sessionRetainMs,
      batchSize,
    );
    const verificationsPurged = await purgeBatches(
      options.db,
      'verification',
      'id',
      options.verificationRetainMs,
      batchSize,
    );
    span.setAttribute('sessionsPurged', sessionsPurged);
    span.setAttribute('verificationsPurged', verificationsPurged);
    if (sessionsPurged > 0) {
      retentionPurgedCounter.add(sessionsPurged, { queue: 'auth', outcome: AUTH_OUTCOME.Session });
    }
    if (verificationsPurged > 0) {
      retentionPurgedCounter.add(verificationsPurged, {
        queue: 'auth',
        outcome: AUTH_OUTCOME.Verification,
      });
    }
    return { sessionsPurged, verificationsPurged };
  });
}

/** Deletes expired rows in bounded batches from one auth evidence table, returning the total.
 * `table`/`keyColumn` are fixed internal literals (never caller input) — `sql.ref` is safe. */
async function purgeBatches(
  db: Kysely<unknown>,
  table: 'session' | 'verification',
  keyColumn: 'id',
  retainMs: number,
  batchSize: number,
): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < MAX_BATCHES_PER_PASS; batch += 1) {
    const result = await sql`
      DELETE FROM auth.${sql.ref(table)}
      WHERE ${sql.ref(keyColumn)} IN (
        SELECT ${sql.ref(keyColumn)} FROM auth.${sql.ref(table)}
        WHERE expires_at < now() - (${retainMs})::double precision * interval '1 millisecond'
        LIMIT ${batchSize}
      )
    `.execute(db);
    const affected = Number(result.numAffectedRows ?? 0n);
    total += affected;
    if (affected < batchSize) {
      break;
    }
  }
  return total;
}

/**
 * `scheduleRepeatable` wiring for {@link purgeExpiredAuthRows}: the ADR-0007 retention
 * pattern applied to this module's own evidence. `schedulerId 'retention:auth'`, stage
 * `auth-retention` (see {@link AUTH_RETENTION_STAGE}). The composition root owns the horizons.
 */
export async function startAuthRetention(options: {
  readonly db: Kysely<unknown>;
  readonly sessionRetainMs: number;
  readonly verificationRetainMs: number;
  readonly batchSize?: number;
  readonly connection: MessagingConnection;
  readonly everyMs: number;
}): Promise<{ close(): Promise<void> }> {
  await scheduleRepeatable({
    stage: AUTH_RETENTION_STAGE,
    connection: options.connection,
    schedulerId: 'retention:auth',
    every: { milliseconds: options.everyMs },
    data: {},
  });

  const worker = createWorker({
    stage: AUTH_RETENTION_STAGE,
    pipeline: 'auth',
    connection: options.connection,
    schema: emptyJobDataSchema,
    handler: async () => {
      await purgeExpiredAuthRows({
        db: options.db,
        sessionRetainMs: options.sessionRetainMs,
        verificationRetainMs: options.verificationRetainMs,
        ...(options.batchSize !== undefined ? { batchSize: options.batchSize } : {}),
      });
    },
  });

  return { close: () => worker.close() };
}
