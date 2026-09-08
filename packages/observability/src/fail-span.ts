import { type Exception, SpanStatusCode, trace } from '@opentelemetry/api';
import { classifyRetry, ERROR_CODE, isAppError } from '@repo/kernel';
import type { Logger } from './logger.js';
import type { FacadeCounter, MetricAttribute } from './metrics.js';
import type { Span } from './with-span.js';

/** The active OTel span, facade-wrapped so boundaries never import `@opentelemetry/api` directly
 * (ADR-0009). Returns `undefined` outside any span context. */
export function activeSpan(): Span | undefined {
  return trace.getActiveSpan();
}

export interface FailSpanOptions {
  /** The boundary's span. Omitted => the active span (Elysia's HTTP server span at the HTTP
   * boundary). When neither exists, span recording is a no-op — counter + log still fire. */
  readonly span?: Span;
  /** The boundary's error counter — MUST share the success instrument's dimensions (ADR-0009).
   * Each boundary passes a fixed instrument; which one is not chosen at the call site. */
  readonly errorCounter: FacadeCounter;
  /** The same bounded attribute values the boundary's success path records (ADR-0009 cardinality
   * budget). */
  readonly attributes?: Partial<Record<MetricAttribute, string>>;
  readonly logger: Logger;
  /** Boundary log message, e.g. 'api.notes: request failed' — stable per boundary, greppable. */
  readonly message: string;
}

/** `Exception` (the OTel span-recording shape) accepts a string or an object with optional
 * name/message/stack/code — an `Error` instance already structurally satisfies it; anything else
 * is coerced to its string form rather than risking a malformed exception event. */
function toRecordableException(error: unknown): Exception {
  if (error instanceof Error) {
    return error;
  }
  return String(error);
}

/**
 * `failSpan` (ADR-0009): the ONE place the error triple is emitted — span status +
 * `recordException`, the error metric sharing the success instrument's dimensions, and exactly
 * one structured log. `withSpan`'s own INV-4 (status only, no `recordException`) stands: this is
 * the only `recordException` call site in the repo.
 *
 * Frozen behavior, in order: (1) resolve the span (`options.span ?? activeSpan()`); if present,
 * `recordException` + status ERROR; (2) `errorCounter.add(1, attributes)`; (3) exactly one
 * `logger.error({ code, reason, cause }, message)`. Each step is isolated in its own try/catch:
 * `failSpan` never throws and never rethrows the input — a broken telemetry path must not mask
 * the original failure, and propagation is the caller's line (`failSpan(error, …); throw …`).
 */
export function failSpan(error: unknown, options: FailSpanOptions): void {
  try {
    const span = options.span ?? activeSpan();
    if (span !== undefined) {
      span.recordException(toRecordableException(error));
      span.setStatus({ code: SpanStatusCode.ERROR });
    }
  } catch {
    // Telemetry recording must never mask the original failure.
  }

  try {
    options.errorCounter.add(1, options.attributes);
  } catch {
    // Same reasoning: a broken counter must not stop the log from firing.
  }

  try {
    const code = isAppError(error) ? error.code : ERROR_CODE.Internal;
    const reason = classifyRetry(error).reason;
    options.logger.error({ code, reason, cause: error }, options.message);
  } catch {
    // Never throws — see function doc.
  }
}
