import { DEFAULT_ATTEMPTS } from '../backoff.js';
import { buildEnvelope, type Envelope } from './envelope.js';
import { BACKOFF_TYPE_CUSTOM, COMPLETED_JOBS_RETAINED } from './producer-options.js';

/** The frozen repeatable-job template shape (named invariant): same producer defaults
 * (attempts, backoff, retention) as the sibling `producerJobOptions`, minus the deterministic
 * `jobId` —
 * the dedup story for repeatables is the scheduler id itself, not `jobIdFor` (documented
 * exception to the jobId rule). Factored out as a pure function so both the "no
 * traceparent" invariant and the frozen opts shape are unit-testable without a live Redis
 * connection. */
export interface RepeatableJobTemplate<TData> {
  readonly name: string;
  readonly data: Envelope<TData>;
  readonly opts: {
    readonly attempts: number;
    readonly backoff: { readonly type: typeof BACKOFF_TYPE_CUSTOM };
    readonly removeOnComplete: { readonly count: number };
    readonly removeOnFail: false;
  };
}

/** A scheduled tick carries the standard envelope WITHOUT `traceparent`: a timer tick
 * has no producer trace — each tick starts a fresh trace. `buildEnvelope(data, {})` already
 * omits carrier fields entirely for an empty carrier (see `envelope.test.ts`). */
export function repeatableJobTemplate<TData>(
  stage: string,
  data: TData,
): RepeatableJobTemplate<TData> {
  return {
    name: stage,
    data: buildEnvelope(data, {}),
    opts: {
      attempts: DEFAULT_ATTEMPTS,
      backoff: { type: BACKOFF_TYPE_CUSTOM },
      removeOnComplete: { count: COMPLETED_JOBS_RETAINED },
      removeOnFail: false,
    },
  };
}

/** Maps {@link RepeatableScheduleOptions.every} to BullMQ's `RepeatOptions`: the
 * `milliseconds`/`cronPattern` union frozen at the messaging boundary becomes BullMQ's own
 * `every`/`pattern` fields. */
export function repeatOptionsFrom(
  every: { readonly milliseconds: number } | { readonly cronPattern: string },
): { readonly every: number } | { readonly pattern: string } {
  return 'milliseconds' in every ? { every: every.milliseconds } : { pattern: every.cronPattern };
}
