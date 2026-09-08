import { SpanStatusCode } from '@opentelemetry/api';
import { node, tracing } from '@opentelemetry/sdk-node';
import { NotFoundError } from '@repo/kernel';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  activeSpan,
  createModuleObservability,
  type FacadeCounter,
  failSpan,
} from '../src/index.js';

// A real (exporter-less would be non-observable) tracer pipeline, same pattern as spans.test.ts:
// in-memory exporter so assertions read what the SDK actually recorded.
const exporter = new tracing.InMemorySpanExporter();
const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  provider.register();
});
afterEach(() => {
  exporter.reset();
});
afterAll(async () => {
  await provider.shutdown();
});

const obs = createModuleObservability('notes');

function silentLogger() {
  const calls: Array<{ obj: unknown; msg: string }> = [];
  return {
    calls,
    logger: {
      fatal: () => undefined,
      error: (obj: unknown, msg?: string) => {
        calls.push({ obj, msg: msg ?? '' });
      },
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      child() {
        return this;
      },
      // biome-ignore lint/suspicious/noExplicitAny: matches the facade Logger overload surface
    } as any,
  };
}

function countingCounter(): { counter: FacadeCounter; calls: unknown[] } {
  const calls: unknown[] = [];
  return {
    calls,
    counter: {
      add: (value, attributes) => {
        calls.push({ value, attributes });
      },
    },
  };
}

describe('failSpan (ADR-0009): the one recordException site', () => {
  it('records exactly one exception event + ERROR status on the given span', async () => {
    const { counter } = countingCounter();
    const { logger } = silentLogger();
    const error = new NotFoundError('missing');

    await obs.withSpan('notes.note.read', (activeCallSpan) => {
      failSpan(error, {
        span: activeCallSpan,
        errorCounter: counter,
        logger,
        message: 'notes: request failed',
      });
    });

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events).toHaveLength(1);
  });

  it('falls back to the active span when none is passed', async () => {
    const { counter } = countingCounter();
    const { logger } = silentLogger();
    const error = new NotFoundError('missing');

    await obs.withSpan('notes.note.read', () => {
      failSpan(error, { errorCounter: counter, logger, message: 'notes: request failed' });
    });

    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events).toHaveLength(1);
  });

  it('no-ops span recording when no span exists (no active span, none passed) — counter + log still fire', () => {
    expect(activeSpan()).toBeUndefined();
    const { counter, calls: counterCalls } = countingCounter();
    const { logger, calls: logCalls } = silentLogger();
    const error = new NotFoundError('missing');

    expect(() =>
      failSpan(error, { errorCounter: counter, logger, message: 'notes: request failed' }),
    ).not.toThrow();

    expect(counterCalls).toHaveLength(1);
    expect(logCalls).toHaveLength(1);
  });

  it('records code (isAppError -> error.code, else INTERNAL) and reason (classifyRetry) on the log line', () => {
    const { counter } = countingCounter();
    const { logger, calls } = silentLogger();

    failSpan(new NotFoundError('missing'), {
      errorCounter: counter,
      logger,
      message: 'notes: request failed',
    });
    expect(calls[0]?.obj).toMatchObject({
      code: 'NOT_FOUND',
      reason: 'app-error-terminal:NOT_FOUND',
    });

    failSpan(new Error('boom'), {
      errorCounter: counter,
      logger,
      message: 'notes: request failed',
    });
    expect(calls[1]?.obj).toMatchObject({ code: 'INTERNAL', reason: 'unknown-default-retry' });
  });

  it('never throws even when the counter and logger both throw internally', () => {
    const throwingCounter: FacadeCounter = {
      add: () => {
        throw new Error('counter exploded');
      },
    };
    const throwingLogger = {
      fatal: () => undefined,
      error: () => {
        throw new Error('logger exploded');
      },
      warn: () => undefined,
      info: () => undefined,
      debug: () => undefined,
      child() {
        return this;
      },
      // biome-ignore lint/suspicious/noExplicitAny: matches the facade Logger overload surface
    } as any;

    expect(() =>
      failSpan(new Error('boom'), {
        errorCounter: throwingCounter,
        logger: throwingLogger,
        message: 'notes: request failed',
      }),
    ).not.toThrow();
  });

  it('never rethrows the input error — propagation is the caller line', () => {
    const { counter } = countingCounter();
    const { logger } = silentLogger();
    expect(() =>
      failSpan('a plain thrown string', {
        errorCounter: counter,
        logger,
        message: 'notes: request failed',
      }),
    ).not.toThrow();
  });
});
