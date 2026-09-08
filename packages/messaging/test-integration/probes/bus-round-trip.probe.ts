/**
 * §9.1 probe: bus round-trip. Run as a real Bun process (see harness/spawn-probe.ts) against a
 * real Redis. Publishes two events under one fabricated trace context: the FIRST delivered
 * event's only handler throws (proving swallow — no crash, no rethrow); the SECOND must still be
 * delivered and handled (proving one failing handler/message does not stop the next). A raw
 * wiretap subscriber (bypassing the bus's own API) captures the literal wire envelope to prove it
 * carries the publisher's `traceparent`.
 *
 * Trace context here is a hand-rolled minimal W3C `traceparent` propagator PLUS a minimal
 * `AsyncLocalStorage`-backed context manager (Node builtin — no new dependency), not a real
 * registered OTel SDK: dep-cruiser's `adapters-and-sdk-only-in-runtime` /
 * `observability-sdk-entry-only-in-runtime` rules confine `@opentelemetry/sdk-*` (which is where
 * the real context manager ships) and `@repo/observability/sdk` to composition roots
 * (`apps/<app>/src/runtime/`) and `packages/observability/` — this probe lives in neither.
 * `@opentelemetry/api`'s own default `NoopContextManager.with()` just calls the callback without
 * tracking anything (verified by hand) — `context.active()` would always read
 * `ROOT_CONTEXT` without a real manager registered, silently no-op-ing this whole probe.
 * `@repo/observability`'s real `injectTraceContext`/`runWithTraceContext` are exercised
 * unmodified; only the registered propagator/context-manager are lightweight stand-ins. Full
 * SDK-backed trace continuation (a consumer span sharing the producer's trace id) is already
 * proven with a real `NodeTracerProvider` in `packages/observability/test/spans.test.ts`
 * (INV-6) — this probe's job is the piece that suite cannot cover: does the envelope actually
 * survive a real Redis wire hop.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import process from 'node:process';
import {
  type Context,
  type ContextManager,
  context,
  propagation,
  ROOT_CONTEXT,
  type SpanContext,
  trace,
} from '@opentelemetry/api';
import { BUS_CHANNEL, createBestEffortEventBus } from '@repo/messaging';
import { z } from 'zod';

/** A local, single-member probe event vocabulary: `createBestEffortEventBus` takes its event
 * schema as a constructor option (like `createWorker`'s `WorkerOptions.schema`), so this probe
 * supplies its own rather than depending on any real domain's bus event. */
const PROBE_EVENT_TYPE = { WidgetProcessed: 'widget.processed' } as const;
const probeEventSchema = z.object({
  type: z.literal(PROBE_EVENT_TYPE.WidgetProcessed),
  widgetId: z.uuid(),
});
type ProbeEvent = z.infer<typeof probeEventSchema>;

class AsyncLocalStorageContextManager implements ContextManager {
  private readonly storage = new AsyncLocalStorage<Context>();

  active(): Context {
    return this.storage.getStore() ?? ROOT_CONTEXT;
  }
  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    ctx: Context,
    fn: F,
    thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    return this.storage.run(ctx, () => fn.call(thisArg, ...args));
  }
  bind<T>(_ctx: Context, target: T): T {
    return target;
  }
  enable(): this {
    return this;
  }
  disable(): this {
    return this;
  }
}
context.setGlobalContextManager(new AsyncLocalStorageContextManager());

const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined) {
  throw new Error('bus-round-trip probe: REDIS_URL is required');
}
const connection = { redisUrl };
// widgetId must be a valid uuid (probeEventSchema: z.uuid()) — two fixed, distinguishable ids
// stand in for "first" (handler throws) and "second" (handler succeeds).
const FIRST_WIDGET_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_WIDGET_ID = '22222222-2222-4222-8222-222222222222';
const KNOWN_TRACE_ID = 'a'.repeat(32);
const KNOWN_SPAN_ID = 'b'.repeat(16);
const EXPECTED_TRACEPARENT = `00-${KNOWN_TRACE_ID}-${KNOWN_SPAN_ID}-01`;

class MinimalTraceparentPropagator {
  inject(ctx: Context, carrier: Record<string, string>): void {
    const spanContext = trace.getSpanContext(ctx);
    if (spanContext === undefined) {
      return;
    }
    carrier.traceparent = `00-${spanContext.traceId}-${spanContext.spanId}-01`;
  }
  extract(ctx: Context, carrier: Record<string, string>): Context {
    const value = carrier.traceparent;
    if (typeof value !== 'string') {
      return ctx;
    }
    const [, traceId, spanId] = value.split('-');
    if (traceId === undefined || spanId === undefined) {
      return ctx;
    }
    return trace.setSpanContext(ctx, { traceId, spanId, traceFlags: 1 } as SpanContext);
  }
  fields(): string[] {
    return ['traceparent'];
  }
}
propagation.setGlobalPropagator(new MinimalTraceparentPropagator());

async function main(): Promise<void> {
  const wiretapMessages: string[] = [];
  const wiretap = new globalThis.Bun.RedisClient(redisUrl);
  await wiretap.subscribe(BUS_CHANNEL, (message) => {
    wiretapMessages.push(message);
  });

  const bus = createBestEffortEventBus<ProbeEvent>({ connection, schema: probeEventSchema });
  const secondReceived: string[] = [];
  let firstHandlerRan = false;

  bus.subscribe(PROBE_EVENT_TYPE.WidgetProcessed, (event) => {
    if (event.widgetId === FIRST_WIDGET_ID) {
      firstHandlerRan = true;
      throw new Error('probe: deliberate handler failure');
    }
    secondReceived.push(event.widgetId);
    return Promise.resolve();
  });
  await bus.start();

  const publishContext = trace.setSpanContext(context.active(), {
    traceId: KNOWN_TRACE_ID,
    spanId: KNOWN_SPAN_ID,
    traceFlags: 1,
  } as SpanContext);
  await context.with(publishContext, async () => {
    await bus.publish({ type: PROBE_EVENT_TYPE.WidgetProcessed, widgetId: FIRST_WIDGET_ID });
    await bus.publish({ type: PROBE_EVENT_TYPE.WidgetProcessed, widgetId: SECOND_WIDGET_ID });
  });

  // Bounded wait for both async deliveries.
  const deadline = Date.now() + 10_000;
  while ((secondReceived.length === 0 || wiretapMessages.length < 2) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  const firstEnvelope =
    wiretapMessages[0] !== undefined ? JSON.parse(wiretapMessages[0]) : undefined;

  await bus.close();
  wiretap.close();

  process.stdout.write(
    `${JSON.stringify({
      firstHandlerRan,
      wiretapTraceparent: firstEnvelope?.traceparent ?? null,
      expectedTraceparent: EXPECTED_TRACEPARENT,
      secondReceived,
    })}\n`,
  );
}

await main();
// `Bun.RedisClient.close()` does not release every handle a subscribed connection holds open
// (verified by hand) — force-exit so the harness's child.on('exit') actually fires.
process.exit(0);
