// Public barrel — the module's entire public contract (ADR-0003: one barrel, no nested barrels).
// This entry depends on `@opentelemetry/api` + pino only; SDK wiring lives behind the `./sdk`
// subpath, importable only from composition roots (ADR-0009; dep-cruiser-enforced).
export { configSlice, type ObservabilitySliceConfig } from './config-slice.js';
export { activeSpan, type FailSpanOptions, failSpan } from './fail-span.js';
export type { Logger } from './logger.js';
export {
  type FacadeCounter,
  type FacadeHistogram,
  type InstrumentSpecification,
  METRIC_ATTRIBUTE,
  type MetricAttribute,
} from './metrics.js';
export {
  createModuleObservability,
  type ModuleObservability,
} from './module-observability.js';
export { injectTraceContext, runWithTraceContext, type TraceCarrier } from './propagation.js';
export {
  type BusEventSpanOptions,
  type JobStageSpanOptions,
  type Span,
  SpanKind,
  type SpanOptions,
  withBusEventSpan,
  withJobStageSpan,
} from './with-span.js';
