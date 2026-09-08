import type { TraceCarrier } from '@repo/observability';

/**
 * The frozen transport envelope: every job payload crossing the queue is wrapped in
 * this shape. `enqueue` fills `traceparent`/`tracestate` via `injectTraceContext()`; the worker
 * extracts them and runs the handler inside `runWithTraceContext` so one trace spans producer
 * and consumer.
 */
export interface Envelope<TData> extends TraceCarrier {
  readonly data: TData;
}

/** Pure envelope construction (unit-testable without a Redis connection, unit plan). */
export function buildEnvelope<TData>(data: TData, carrier: TraceCarrier): Envelope<TData> {
  return { ...carrier, data };
}
