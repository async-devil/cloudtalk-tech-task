import { context, propagation } from '@opentelemetry/api';

/**
 * W3C tracecontext fields carried explicitly through async hops — queue job payloads and bus
 * events (ADR-0009: explicit carriage is the only propagation that survives queue/bus
 * indirection). The messaging module injects on produce and extracts on consume.
 */
export interface TraceCarrier {
  traceparent?: string;
  tracestate?: string;
}

/** Captures the active trace context into a carrier (empty when no propagator/span is active). */
export function injectTraceContext(): TraceCarrier {
  const carrier: TraceCarrier = {};
  propagation.inject(context.active(), carrier);
  return carrier;
}

/** Runs `fn` with the carrier's trace context active — a consumer-side span started inside
 * becomes a child of the producer's span, so one trace covers the pipeline end to end. */
export function runWithTraceContext<T>(carrier: TraceCarrier, fn: () => Promise<T>): Promise<T> {
  const extracted = propagation.extract(context.active(), carrier);
  return context.with(extracted, fn);
}
