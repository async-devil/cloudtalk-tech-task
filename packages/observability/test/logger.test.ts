import { node, tracing } from '@opentelemetry/sdk-node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createModuleObservability } from '../src/index.js';
import { buildProcessLogger, setProcessLogger } from '../src/internal/logger-state.js';

// Same-package internal import: the process-logger seam is this module's own internals under
// test (ADR-0010 — invariants pinned where they live), not a cross-module deep import.

const provider = new node.NodeTracerProvider({
  spanProcessors: [new tracing.SimpleSpanProcessor(new tracing.InMemorySpanExporter())],
});
beforeAll(() => {
  provider.register();
});
afterAll(async () => {
  await provider.shutdown();
});

interface Sink {
  lines: string[];
  write(msg: string): void;
}
function sink(): Sink {
  const lines: string[] = [];
  return {
    lines,
    write(msg: string): void {
      lines.push(msg);
    },
  };
}
function records(s: Sink): Array<Record<string, unknown>> {
  return s.lines.flatMap((chunk) =>
    chunk
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

describe('trace correlation mixin (ADR-0009, INV-7)', () => {
  it('a log emitted inside an active span carries trace_id/span_id/trace_flags', async () => {
    const capture = sink();
    setProcessLogger(buildProcessLogger({ level: 'info', pretty: false, destination: capture }));
    const obs = createModuleObservability('notes');

    let expectedTraceId = '';
    await obs.withSpan('notes.note.create', (span) => {
      expectedTraceId = span.spanContext().traceId;
      obs.logger.info('inside');
    });
    obs.logger.info('outside');

    const [inside, outside] = records(capture);
    expect(inside?.trace_id).toBe(expectedTraceId);
    expect(inside?.span_id).toMatch(/^[0-9a-f]{16}$/);
    expect(inside?.trace_flags).toBeDefined();
    expect(inside?.module).toBe('notes');
    expect(outside?.trace_id).toBeUndefined();
  });

  it('module loggers re-bind lazily when the process logger is replaced (INV-8)', () => {
    const before = sink();
    setProcessLogger(buildProcessLogger({ level: 'info', pretty: false, destination: before }));
    const obs = createModuleObservability('notes');
    obs.logger.info('first');

    const after = sink();
    setProcessLogger(buildProcessLogger({ level: 'debug', pretty: false, destination: after }));
    obs.logger.debug({ detail: true }, 'second');

    expect(records(before)).toHaveLength(1);
    const [second] = records(after);
    expect(second?.msg).toBe('second');
    expect(second?.detail).toBe(true);
    expect(second?.module).toBe('notes');
  });
});

describe('central redaction (ADR-0009, INV-9): call sites cannot opt out', () => {
  it('seeded secrets never appear in output', () => {
    const capture = sink();
    setProcessLogger(buildProcessLogger({ level: 'info', pretty: false, destination: capture }));
    const obs = createModuleObservability('notes');

    obs.logger.info(
      {
        password: 'hunter2',
        credentials: { token: 'tok_123', apiKey: 'ak_123', api_key: 'ak_456', secret: 's3cr3t' },
        req: { headers: { authorization: 'Bearer abc', cookie: 'sid=xyz', Cookie: 'SID=XYZ' } },
        headers: { Authorization: 'Basic def' },
        // The `email` / `*.email` pair: a PII-shaped path on the reviewed redact list — a
        // reviewer's email address must appear in logs only as a redacted field, never raw.
        email: 'plain-email@example.test',
        nested: { email: 'nested-email@example.test' },
      },
      'request',
    );

    const raw = capture.lines.join('\n');
    for (const secret of [
      'hunter2',
      'tok_123',
      'ak_123',
      'ak_456',
      's3cr3t',
      'Bearer abc',
      'sid=xyz',
      'SID=XYZ',
      'Basic def',
      'plain-email@example.test',
      'nested-email@example.test',
    ]) {
      expect(raw, secret).not.toContain(secret);
    }
    expect(raw).toContain('[REDACTED]');
  });
});
