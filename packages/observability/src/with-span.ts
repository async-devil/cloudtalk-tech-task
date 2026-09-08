import { type Span, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
import { assertEventType, assertModuleName, assertSegment } from './internal/naming.js';

export type { Span };
export { SpanKind };

export interface SpanOptions {
  /** Defaults to INTERNAL. */
  readonly kind?: SpanKind;
  readonly attributes?: Record<string, string | number | boolean>;
}

const TRACER_NAME = '@repo/observability';

function runInSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  options: SpanOptions | undefined,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(
    name,
    {
      kind: options?.kind ?? SpanKind.INTERNAL,
      attributes: { ...attributes, ...options?.attributes },
    },
    async (span) => {
      try {
        return await fn(span);
      } catch (err) {
        // Status only. recordException + the error counter + the single log belong to the
        // boundary helper (ADR-0009 failSpan) — doing it here too would double-fire the error
        // triple on every propagation hop.
        span.setStatus({ code: SpanStatusCode.ERROR });
        throw err;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * Runs `fn` inside a module-owned span named `{module}.{object}.{verb}` (ADR-0009). The name is
 * validated structurally: full three-segment shape, first segment === the owning module. Sets
 * the mandatory `module` attribute. On throw: span status ERROR, rethrow — nothing else.
 * @internal Constructed via `createModuleObservability`.
 */
export function moduleWithSpan(moduleName: string) {
  return <T>(
    name: string,
    fn: (span: Span) => Promise<T> | T,
    options?: SpanOptions,
  ): Promise<T> => {
    assertModuleName(moduleName, name, 'span name');
    return runInSpan(name, { module: moduleName }, options, fn);
  };
}

export interface JobStageSpanOptions extends SpanOptions {
  readonly pipeline: string;
  readonly stage: string;
}

/**
 * Runs `fn` inside a job-stage span named `jobs.{pipeline}.{stage}` — ADR-0009's job-stage span
 * class, the one sanctioned exception to the module-prefix rule. Emitted ONLY by the messaging
 * module's worker wrapper; anywhere else is a review reject (a natural arch-check target: grep
 * for call sites outside `@repo/messaging`).
 */
export function withJobStageSpan<T>(
  options: JobStageSpanOptions,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  assertSegment(options.pipeline, 'job pipeline');
  assertSegment(options.stage, 'job stage');
  const { pipeline, stage, ...spanOptions } = options;
  return runInSpan(
    `jobs.${pipeline}.${stage}`,
    { module: 'messaging', pipeline, stage },
    { ...spanOptions, kind: spanOptions.kind ?? SpanKind.CONSUMER },
    fn,
  );
}

export interface BusEventSpanOptions extends SpanOptions {
  /** A {@link BusEventType} value, e.g. `'note.processed'` (validated as lowercase dot-separated
   * segments — the messaging package's own union type isn't reachable from here, ADR-0001). */
  readonly eventType: string;
}

/**
 * Runs `fn` inside a bus-event span named `event.{eventType}` — ADR-0009's third span class
 * (module-owned, `jobs.{pipeline}.{stage}`, `event.{type}`). Emitted ONLY by the messaging
 * module's bus consume path; anywhere else is a review reject.
 */
export function withBusEventSpan<T>(
  options: BusEventSpanOptions,
  fn: (span: Span) => Promise<T> | T,
): Promise<T> {
  assertEventType(options.eventType, 'bus event type');
  const { eventType, ...spanOptions } = options;
  return runInSpan(
    `event.${eventType}`,
    { module: 'messaging', queue: eventType },
    { ...spanOptions, kind: spanOptions.kind ?? SpanKind.CONSUMER },
    fn,
  );
}
