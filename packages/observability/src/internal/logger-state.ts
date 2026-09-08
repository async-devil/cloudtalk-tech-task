import { trace } from '@opentelemetry/api';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';

/**
 * The single reviewed redaction list (ADR-0009): adding a path is a change to THIS file only —
 * call sites cannot opt out. pino wildcard paths match exactly one level, so the list covers the
 * top level and one nesting level for the secret-shaped keys, plus authorization/cookie headers
 * in both common casings under any one-level parent. Deeper nestings are not reachable by pino
 * redaction — never log free-form deep objects containing credentials (README invariant; the
 * seeded-secrets test pins the covered shapes).
 */
export const REDACT_PATHS: readonly string[] = [
  'password',
  'token',
  'secret',
  'apiKey',
  'api_key',
  // `email` is PII — email addresses must never appear in logs, so it sits on this single
  // reviewed list beside the auth funnel's tokens, which the `token` paths already cover.
  // Magic-link URLs are kept out of logs by never logging them (auth README invariant), not by a
  // broad `url` path here — redacting every field named `url` repo-wide would erase legitimately
  // useful non-secret URLs from operational logs.
  'email',
  '*.password',
  '*.token',
  '*.secret',
  '*.apiKey',
  '*.api_key',
  '*.email',
  'headers.authorization',
  'headers.Authorization',
  'headers.cookie',
  'headers.Cookie',
  'headers["set-cookie"]',
  '*.headers.authorization',
  '*.headers.Authorization',
  '*.headers.cookie',
  '*.headers.Cookie',
  '*.headers["set-cookie"]',
];

export interface ProcessLoggerOptions {
  readonly level: string;
  /** Pretty transport is dev-only (ADR-0009); JSON single-line otherwise. */
  readonly pretty: boolean;
  /** Test seam: capture records instead of writing to stdout. */
  readonly destination?: DestinationStream;
}

/**
 * Builds the process pino logger (ADR-0009): trace-correlation mixin (`trace_id`, `span_id`,
 * `trace_flags` injected on every record emitted inside an active span context) + the central
 * redaction config. `pino(` appears only in this package (lint-enforced repo-wide).
 */
export function buildProcessLogger(options: ProcessLoggerOptions): Logger {
  const pinoOptions: LoggerOptions = {
    level: options.level,
    // Allocation-light: one object per record, only when a span is active.
    mixin(): Record<string, unknown> {
      const spanContext = trace.getActiveSpan()?.spanContext();
      if (spanContext === undefined) {
        return {};
      }
      return {
        trace_id: spanContext.traceId,
        span_id: spanContext.spanId,
        trace_flags: spanContext.traceFlags,
      };
    },
    redact: { paths: [...REDACT_PATHS], censor: '[REDACTED]' },
    ...(options.pretty ? { transport: { target: 'pino-pretty' } } : {}),
  };
  return options.destination !== undefined
    ? pino(pinoOptions, options.destination)
    : pino(pinoOptions);
}

/**
 * Process-wide logger slot. `initObservability` (the composition root, via `/sdk`) replaces the
 * default; facade loggers resolve through this indirection on every emit, so modules constructed
 * before init still log through the configured logger afterwards ("lazily-bound").
 */
let processLogger: Logger | undefined;
/** Bumped on every setProcessLogger so cached module children re-resolve. */
let generation = 0;

export function setProcessLogger(logger: Logger): void {
  processLogger = logger;
  generation += 1;
}

export function getProcessLogger(): Logger {
  if (processLogger === undefined) {
    processLogger = buildProcessLogger({ level: 'info', pretty: false });
    generation += 1;
  }
  return processLogger;
}

export function loggerGeneration(): number {
  return generation;
}
