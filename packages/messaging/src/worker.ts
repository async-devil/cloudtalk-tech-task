import { classifyRetry, describeError, RETRY_DECISION, ValidationError } from '@repo/kernel';
import {
  createModuleObservability,
  failSpan,
  METRIC_ATTRIBUTE,
  runWithTraceContext,
  type Span,
  type TraceCarrier,
  withJobStageSpan,
} from '@repo/observability';
import { UnrecoverableError, Worker } from 'bullmq';
import type { z } from 'zod';
import { type BackoffOptions, DEFAULT_BACKOFF, fullJitterBackoff } from './backoff.js';
import type { MessagingConnection } from './connection.js';
import { bunRedisConnection } from './internal/bun-redis.js';
import type { Envelope } from './internal/envelope.js';
import { boundedReadinessProbe } from './internal/readiness-probe.js';
import { workerLimiterOptions } from './internal/worker-limiter.js';

const obs = createModuleObservability('messaging');

/**
 * The job boundary's outcome vocabulary, as a
 * const-object value set (ADR-0003).
 */
export const JOB_OUTCOME = {
  Completed: 'completed',
  RetryScheduled: 'retry-scheduled',
  Terminal: 'terminal',
} as const;
export type JobOutcome = (typeof JOB_OUTCOME)[keyof typeof JOB_OUTCOME];

/** `messaging.job.execute`: the success path and both failure paths share this one
 * instrument/dimension set — `{ queue, outcome }` — so the DoD's counter-dimension identity holds
 * by construction, never by convention. */
const jobExecuteCounter = obs.createCounter({
  name: 'messaging.job.execute',
  allowedAttributes: [METRIC_ATTRIBUTE.Queue, METRIC_ATTRIBUTE.Outcome],
});

/** Options accepted by {@link createWorker} (frozen). */
export interface WorkerOptions<TData> {
  readonly stage: string;
  /** Span naming: `jobs.{pipeline}.{stage}` (ADR-0009). */
  readonly pipeline: string;
  readonly connection: MessagingConnection;
  /** Parsed at entry; failure is terminal (ValidationError), never retried. */
  readonly schema: z.ZodType<TData>;
  readonly handler: (job: { data: TData; entityId: string; attempt: number }) => Promise<void>;
  /** Default 1. */
  readonly concurrency?: number;
  /** Backoff bounds for the custom `fullJitterBackoff` strategy. Default `{ baseMs: 1000,
   * capMs: 60_000 }` — matches `createQueue`'s producer default. */
  readonly backoff?: BackoffOptions;
  /** Max jobs processed per window across this worker — BullMQ's worker-level limiter
   * (ADR-0007). Unset means unlimited. */
  readonly limiter?: {
    readonly max: number;
    readonly durationMs: number;
  };
}

/** Handle returned by {@link createWorker} (frozen; `isReady` is an *additive amendment*
 * — 's amendment item 2 — nothing else in this shape changes). */
export interface WorkerHandle {
  close(): Promise<void>;
  /**
   * Whether this worker's BullMQ connection is up and the worker is actively processing (
   * 's `/health/worker` probe): bounded to a small internal deadline (`internal/
   * readiness-probe.ts`) and NEVER throws — a probe that hangs or crashes its caller is a worse
   * readiness signal than an honest `false`. Checks BOTH facts BullMQ exposes: the blocking
   * connection is established (`Worker.waitUntilReady()`, bounded) AND the worker has not been
   * closed/is still running (`Worker.isRunning()`, synchronous) — a worker whose connection came
   * up but was then `close()`d must report `false`, not the stale `true` a connection-only check
   * would give.
   */
  isReady(): Promise<boolean>;
}

/**
 * Extracts the entity id BullMQ's own `jobId` was constructed from
 * (`jobIdFor(stage, entityId)` = `` `${stage}_${entityId}` ``).
 */
function entityIdFromJobId(stage: string, jobId: string | undefined): string {
  const prefix = `${stage}_`;
  if (jobId?.startsWith(prefix)) {
    return jobId.slice(prefix.length);
  }
  return jobId ?? '';
}

/** Strips `undefined` values (`exactOptionalPropertyTypes`: a present-but-undefined key is not
 * the same as an absent one — the envelope's carrier fields are optional, not nullable). */
function carrierFrom(envelope: { traceparent?: string; tracestate?: string }): TraceCarrier {
  const carrier: TraceCarrier = {};
  if (envelope.traceparent !== undefined) {
    carrier.traceparent = envelope.traceparent;
  }
  if (envelope.tracestate !== undefined) {
    carrier.tracestate = envelope.tracestate;
  }
  return carrier;
}

/**
 * The per-attempt job boundary, factored out of
 * {@link createWorker}'s BullMQ wiring so it is directly unit-testable (ADR-0010.5's "plain
 * exported function" seam, one level up from the raw handler): runs `handler` inside a
 * `jobs.{pipeline}.{stage}` span (`withJobStageSpan`, ADR-0009's sanctioned exception), parses
 * `job.data` against `schema` before the handler ever sees it, and classifies handler failures via
 * the kernel's `classifyRetry` (docs/adr/0014-bullmq-redis-jobs-transport.md,
 * docs/adr/0026-opentelemetry-adoption.md): Terminal failures get the one boundary log
 * (`failSpan`, the queue's `{queue, outcome: Terminal}` counter tick) and become a BullMQ
 * `UnrecoverableError(describeError(error))` (terminal, no further retry); Retry failures tick the
 * counter `{queue, outcome: RetryScheduled}` — no log, no `recordException` — and rethrow for
 * BullMQ's own attempts/backoff (the span's ERROR status from the throw suffices; logging every
 * transient attempt is the noise ADR-0009 exists to kill). Schema-parse failures route through the
 * same terminal `failSpan` + `UnrecoverableError` shape.
 * @internal exported for `test/worker.test.ts` only (relative import, not through the barrel).
 */
export async function runJobStage<TData>(
  options: Pick<WorkerOptions<TData>, 'stage' | 'pipeline' | 'schema' | 'handler'>,
  jobData: Envelope<TData>,
  jobId: string | undefined,
  attemptsMade: number,
): Promise<void> {
  const entityId = entityIdFromJobId(options.stage, jobId);
  const queue = options.stage;

  function terminalFailure(span: Span, error: unknown): never {
    failSpan(error, {
      span,
      errorCounter: jobExecuteCounter,
      attributes: { queue, outcome: JOB_OUTCOME.Terminal },
      logger: obs.logger,
      message: `${options.stage}: job failed terminally`,
    });
    throw new UnrecoverableError(describeError(error));
  }

  await runWithTraceContext(carrierFrom(jobData), () =>
    withJobStageSpan({ pipeline: options.pipeline, stage: options.stage }, async (span) => {
      const parsed = options.schema.safeParse(jobData.data);
      if (!parsed.success) {
        terminalFailure(
          span,
          new ValidationError(
            `${options.stage}: job data failed schema validation: ${parsed.error.message}`,
          ),
        );
      }
      try {
        await options.handler({
          data: parsed.data,
          entityId,
          attempt: attemptsMade + 1,
        });
        jobExecuteCounter.add(1, { queue, outcome: JOB_OUTCOME.Completed });
      } catch (error) {
        const classification = classifyRetry(error);
        if (classification.decision === RETRY_DECISION.Terminal) {
          terminalFailure(span, error);
        }
        jobExecuteCounter.add(1, { queue, outcome: JOB_OUTCOME.RetryScheduled });
        throw error;
      }
    }),
  );
}

/**
 * Wraps a BullMQ `Worker` for one stage: extracts the envelope and delegates each
 * attempt to {@link runJobStage} — the only place that touches `bullmq` types.
 */
export function createWorker<TData>(options: WorkerOptions<TData>): WorkerHandle {
  const backoff = options.backoff ?? DEFAULT_BACKOFF;

  const worker = new Worker<Envelope<TData>>(
    options.stage,
    (job) => runJobStage(options, job.data, job.id, job.attemptsMade),
    {
      connection: bunRedisConnection(options.connection),
      concurrency: options.concurrency ?? 1,
      settings: {
        backoffStrategy: (attemptsMade: number) => fullJitterBackoff(attemptsMade, backoff),
      },
      ...(options.limiter !== undefined ? { limiter: workerLimiterOptions(options.limiter) } : {}),
    },
  );

  return {
    async close(): Promise<void> {
      await worker.close();
    },
    async isReady(): Promise<boolean> {
      const result = await boundedReadinessProbe(worker.waitUntilReady());
      if (result === undefined) {
        return false;
      }
      return worker.isRunning();
    },
  };
}
