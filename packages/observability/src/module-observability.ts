import { assertSegment } from './internal/naming.js';
import { createModuleLogger, type Logger } from './logger.js';
import {
  createModuleCounter,
  createModuleHistogram,
  type FacadeCounter,
  type FacadeHistogram,
  type InstrumentSpecification,
} from './metrics.js';
import { moduleWithSpan, type Span, type SpanOptions } from './with-span.js';

/**
 * The per-module facade: everything a module may touch of the observability stack. Modules depend
 * on `@repo/observability` only — never on `@opentelemetry/sdk-*` or `pino` directly (ADR-0009;
 * dep-cruiser-enforced).
 */
export interface ModuleObservability {
  withSpan<T>(name: string, fn: (span: Span) => Promise<T> | T, options?: SpanOptions): Promise<T>;
  readonly logger: Logger;
  createCounter(specification: InstrumentSpecification): FacadeCounter;
  createHistogram(specification: InstrumentSpecification & { unit: string }): FacadeHistogram;
}

/**
 * Creates the facade for one module. `moduleName` prefixes (and is validated against) every span
 * and instrument name, is bound onto every log record, and is set as the `module` attribute on
 * every span (ADR-0009 mandatory attributes).
 */
export function createModuleObservability(moduleName: string): ModuleObservability {
  assertSegment(moduleName, 'module name');
  const withSpan = moduleWithSpan(moduleName);
  return {
    withSpan,
    logger: createModuleLogger(moduleName),
    createCounter: (specification) => createModuleCounter(moduleName, specification),
    createHistogram: (specification) => createModuleHistogram(moduleName, specification),
  };
}
