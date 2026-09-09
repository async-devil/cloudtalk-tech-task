import { ValidationError } from '@repo/kernel';
import {
  createModuleObservability,
  failSpan,
  injectTraceContext,
  METRIC_ATTRIBUTE,
  runWithTraceContext,
  type TraceCarrier,
  withBusEventSpan,
} from '@repo/observability';
import type { z } from 'zod';
import type { MessagingConnection } from './connection.js';
import { createIntervalSuppressor } from './internal/log-suppressor.js';

const obs = createModuleObservability('messaging');

/** The single pub/sub channel (versioned so a future wire change is a NEW channel, not a
 * flag-day). Wire payload: the standard envelope `{ traceparent?, tracestate?, event }`. */
export const BUS_CHANNEL = 'bus:events:v1';

/** The bus boundary's outcome vocabulary: `Completed`/`Terminal` only — no
 * `RetryScheduled`, the bus never retries (ADR-0003's const-object rule). Not part of the
 * public barrel: it is internal to this boundary. Same literal values as
 * `@repo/messaging`'s `JOB_OUTCOME`, declared separately: a bus event handler outcome is not a
 * job outcome even where the strings coincide. */
const EVENT_OUTCOME = {
  Completed: 'completed',
  Terminal: 'terminal',
} as const;

/** A delivered message whose envelope/event failed to parse has no known event type yet — this
 * fixed, bounded literal stands in for the `queue` metric attribute in that one case (ADR-0009:
 * bounded enums only, never a raw/unparsed value). */
const UNKNOWN_EVENT_TYPE = 'unknown';

const eventHandleCounter = obs.createCounter({
  name: 'messaging.event.handle',
  allowedAttributes: [METRIC_ATTRIBUTE.Queue, METRIC_ATTRIBUTE.Outcome],
});
const eventPublishCounter = obs.createCounter({
  name: 'messaging.event.publish',
  allowedAttributes: [METRIC_ATTRIBUTE.Queue, METRIC_ATTRIBUTE.Outcome],
});

interface BusEnvelope extends TraceCarrier {
  readonly event?: unknown;
}

function carrierFrom(envelope: TraceCarrier): TraceCarrier {
  const carrier: TraceCarrier = {};
  if (envelope.traceparent !== undefined) {
    carrier.traceparent = envelope.traceparent;
  }
  if (envelope.tracestate !== undefined) {
    carrier.tracestate = envelope.tracestate;
  }
  return carrier;
}

/** ADR-0007: the bus's own boundary — the messaging module's no-core-logging allowlist slot
 * reserved for `internal/bus*.ts`. `TEvent` is the caller's own closed bus-event vocabulary
 * (a `type`-discriminated union) — this module owns no concrete event, so every event union is
 * supplied by the caller at construction (the same `schema`-parameter shape `createWorker` already
 * uses for job payloads, `worker.ts`'s `WorkerOptions.schema`), not hardcoded against a sibling
 * module's contract. */
export interface BestEffortEventBus<TEvent extends { readonly type: string }> {
  /**
   * AT-MOST-ONCE, no acks, no retries — by contract (ADR-0007; it's in the type name).
   * Auto-injects the active W3C trace context. NEVER throws and never rejects: a publish
   * failure is logged once per interval and ticked on the publish counter — nothing
   * state-critical may depend on delivery (usage law), so nothing may crash on non-delivery.
   */
  publish(event: TEvent): Promise<void>;
  /** Registration is centralized in composition roots (ADR-0007). Multiple handlers per type
   * allowed; handlers run sequentially per delivered message. */
  subscribe<TType extends TEvent['type']>(
    type: TType,
    handler: (event: Extract<TEvent, { type: TType }>) => Promise<void>,
  ): void;
  /** Opens the DEDICATED subscriber connection (a Redis client in subscriber mode cannot issue
   * other commands — the bus holds two clients: publisher + subscriber). Call after all
   * `subscribe` registrations, before serving traffic (composition-root boot order). */
  start(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Creates a {@link BestEffortEventBus} over `Bun.RedisClient`'s native `publish`/`subscribe`
 *. Built on two raw clients — one for publishing, one dedicated to the subscription —
 * so publishing is never blocked behind the subscriber connection's mode. `options.schema` is the
 * caller's closed, `type`-discriminated bus-event union (parsed at the consume boundary, ADR-0004)
 * — this module never imports a concrete event vocabulary of its own.
 */
export function createBestEffortEventBus<TEvent extends { readonly type: string }>(options: {
  readonly connection: MessagingConnection;
  readonly schema: z.ZodType<TEvent>;
}): BestEffortEventBus<TEvent> {
  const publisher = new globalThis.Bun.RedisClient(options.connection.redisUrl);
  const subscriber = new globalThis.Bun.RedisClient(options.connection.redisUrl);
  const handlers = new Map<string, Array<(event: TEvent) => Promise<void>>>();
  const logPublishFailureOnce = createIntervalSuppressor();

  function terminalFailure(error: unknown, message: string): void {
    failSpan(error, {
      errorCounter: eventHandleCounter,
      attributes: { queue: UNKNOWN_EVENT_TYPE, outcome: EVENT_OUTCOME.Terminal },
      logger: obs.logger,
      message,
    });
  }

  async function handleMessage(raw: string): Promise<void> {
    let envelope: unknown;
    try {
      envelope = JSON.parse(raw);
    } catch (error) {
      terminalFailure(
        new ValidationError(`messaging bus: envelope is not valid JSON: ${String(error)}`),
        'messaging.bus: envelope parse failed',
      );
      return;
    }

    // The envelope's SHAPE is checked before anything is read off it (review, 2026-09-09).
    // `JSON.parse` happily returns `null`, a number or a string, and `record.event` on a `null`
    // envelope throws a TypeError from inside this detached async call — surfacing as an unhandled
    // rejection rather than as the terminal parse failure this boundary exists to record. A
    // payload that is not an object is exactly that: an envelope that failed to parse.
    if (typeof envelope !== 'object' || envelope === null || Array.isArray(envelope)) {
      terminalFailure(
        new ValidationError('messaging bus: envelope is not a JSON object'),
        'messaging.bus: envelope parse failed',
      );
      return;
    }

    const record = envelope as BusEnvelope;
    const parsed = options.schema.safeParse(record.event);
    if (!parsed.success) {
      terminalFailure(
        new ValidationError(
          `messaging bus: event failed schema validation: ${parsed.error.message}`,
        ),
        'messaging.bus: event validation failed',
      );
      return;
    }

    const event = parsed.data;
    await runWithTraceContext(carrierFrom(record), () =>
      withBusEventSpan({ eventType: event.type }, async (span) => {
        const registered = handlers.get(event.type) ?? [];
        if (registered.length === 0) {
          eventHandleCounter.add(1, { queue: event.type, outcome: EVENT_OUTCOME.Completed });
          return;
        }
        // Sequential per delivered message: one failing handler does not stop the
        // next handler or the next message.
        for (const handler of registered) {
          try {
            await handler(event);
            eventHandleCounter.add(1, { queue: event.type, outcome: EVENT_OUTCOME.Completed });
          } catch (error) {
            failSpan(error, {
              span,
              errorCounter: eventHandleCounter,
              attributes: { queue: event.type, outcome: EVENT_OUTCOME.Terminal },
              logger: obs.logger,
              message: 'messaging.bus: handler failed',
            });
          }
        }
      }),
    );
  }

  return {
    async publish(event: TEvent): Promise<void> {
      try {
        const envelope: BusEnvelope = { ...injectTraceContext(), event };
        await publisher.publish(BUS_CHANNEL, JSON.stringify(envelope));
        eventPublishCounter.add(1, { queue: event.type, outcome: EVENT_OUTCOME.Completed });
      } catch (error) {
        eventPublishCounter.add(1, { queue: event.type, outcome: EVENT_OUTCOME.Terminal });
        // Publisher connection failures are `warn`-degraded, not a boundary error (ADR-0008): a
        // best-effort bus with a down Redis is exactly "degraded but operating".
        logPublishFailureOnce(obs.logger, 'messaging.bus: publish failed', {
          queue: event.type,
          cause: String(error),
        });
      }
    },
    subscribe<TType extends TEvent['type']>(
      type: TType,
      handler: (event: Extract<TEvent, { type: TType }>) => Promise<void>,
    ): void {
      const registered = handlers.get(type) ?? [];
      registered.push(handler as (event: TEvent) => Promise<void>);
      handlers.set(type, registered);
    },
    async start(): Promise<void> {
      await subscriber.subscribe(BUS_CHANNEL, (message) => {
        // The subscribe callback is synchronous, so dispatch cannot be awaited here — but it MUST
        // be caught (review, 2026-09-09). Every failure `handleMessage` anticipates is already
        // recorded inside it; this catch is for the ones it does not, which would otherwise leave
        // the process as an unhandled rejection and take a bus subscriber's crash policy with
        // them. Routed to the same terminal outcome as any other undeliverable message.
        void handleMessage(message).catch((error: unknown) => {
          terminalFailure(error, 'messaging.bus: message dispatch failed');
        });
      });
    },
    close(): Promise<void> {
      subscriber.close();
      publisher.close();
      return Promise.resolve();
    },
  };
}
