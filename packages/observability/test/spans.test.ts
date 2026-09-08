import { SpanStatusCode } from '@opentelemetry/api';
import { node, tracing } from '@opentelemetry/sdk-node';
import { NotFoundError } from '@repo/kernel';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createModuleObservability,
  injectTraceContext,
  runWithTraceContext,
  SpanKind,
  withBusEventSpan,
  withJobStageSpan,
} from '../src/index.js';

// A real (exporter-less would be non-observable) tracer pipeline: in-memory exporter so tests can
// assert what actually leaves the SDK — names, attributes, status, events, parentage.
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

describe('withSpan (ADR-0009, INV-3)', () => {
  it('emits the validated name, module attribute, and INTERNAL kind by default', async () => {
    await obs.withSpan('notes.note.create', () => undefined);
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('notes.note.create');
    expect(span?.attributes.module).toBe('notes');
    expect(span?.kind).toBe(SpanKind.INTERNAL);
  });

  it('returns the callback result and merges caller attributes', async () => {
    const result = await obs.withSpan('notes.note.create', () => 42, {
      attributes: { attempt: 1 },
    });
    expect(result).toBe(42);
    expect(exporter.getFinishedSpans()[0]?.attributes.attempt).toBe(1);
  });

  it('on throw: ERROR status, rethrow, NO exception event (INV-4; failSpan owns recording)', async () => {
    const boom = new NotFoundError('missing');
    await expect(
      obs.withSpan('notes.note.read', () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    const [span] = exporter.getFinishedSpans();
    expect(span?.status.code).toBe(SpanStatusCode.ERROR);
    expect(span?.events).toHaveLength(0);
  });
});

describe('withJobStageSpan (ADR-0009 job-stage class, INV-5)', () => {
  it('names the span jobs.{pipeline}.{stage} with CONSUMER kind and stage attributes', async () => {
    await withJobStageSpan({ pipeline: 'slice', stage: 'uppercase-note' }, () => undefined);
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('jobs.slice.uppercase-note');
    expect(span?.kind).toBe(SpanKind.CONSUMER);
    expect(span?.attributes.pipeline).toBe('slice');
    expect(span?.attributes.stage).toBe('uppercase-note');
    expect(span?.attributes.module).toBe('messaging');
  });
});

describe('withBusEventSpan (ADR-0009 event-bus span class)', () => {
  it('names the span event.{eventType} with CONSUMER kind and module/queue attributes', async () => {
    await withBusEventSpan({ eventType: 'note.processed' }, () => undefined);
    const [span] = exporter.getFinishedSpans();
    expect(span?.name).toBe('event.note.processed');
    expect(span?.kind).toBe(SpanKind.CONSUMER);
    expect(span?.attributes.module).toBe('messaging');
    expect(span?.attributes.queue).toBe('note.processed');
  });
});

describe('trace propagation through an explicit carrier (ADR-0009, INV-6)', () => {
  it('a consumer-side span joins the producer trace via inject → carrier → extract', async () => {
    let carrier: ReturnType<typeof injectTraceContext> = {};
    await obs.withSpan('notes.note.create', () => {
      carrier = injectTraceContext();
    });
    expect(carrier.traceparent).toBeDefined();

    await runWithTraceContext(carrier, async () => {
      await withJobStageSpan({ pipeline: 'slice', stage: 'uppercase-note' }, () => undefined);
    });

    const spans = exporter.getFinishedSpans();
    const producer = spans.find((s) => s.name === 'notes.note.create');
    const consumer = spans.find((s) => s.name === 'jobs.slice.uppercase-note');
    expect(consumer?.spanContext().traceId).toBe(producer?.spanContext().traceId);
    expect(consumer?.parentSpanContext?.spanId).toBe(producer?.spanContext().spanId);
  });
});
