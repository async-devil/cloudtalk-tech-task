import process from 'node:process';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createBestEffortEventBus } from '../src/bus.js';

/** A local, single-member test event vocabulary (ADR-0007's shape): `createBestEffortEventBus`
 * takes its event schema as a constructor option (like `createWorker`'s `WorkerOptions.schema`),
 * so this suite supplies its own rather than reaching into a sibling module's contract for a
 * concrete event to publish. */
const TEST_EVENT_TYPE = { WidgetProcessed: 'widget.processed' } as const;
const testEventSchema = z.object({
  type: z.literal(TEST_EVENT_TYPE.WidgetProcessed),
  widgetId: z.uuid(),
});
type TestEvent = z.infer<typeof testEventSchema>;

/** Same technique as `worker.test.ts`: `setProcessLogger`'s destination seam is internal to
 * `@repo/observability` (ADR-0001, cross-package), so this intercepts the facade's default
 * `process.stdout` destination instead. */
function captureStdout(): { lines: string[]; restore(): void } {
  const lines: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // biome-ignore lint/suspicious/noExplicitAny: matching Node's overloaded `write` signature
  (process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    lines.push(String(chunk));
    return original(chunk, ...rest);
  };
  return {
    lines,
    restore(): void {
      process.stdout.write = original;
    },
  };
}

function jsonLines(lines: readonly string[]): Array<Record<string, unknown>> {
  return lines
    .flatMap((chunk) => chunk.split('\n'))
    .filter((line) => line.trim() !== '')
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return undefined;
      }
    })
    .filter((parsed): parsed is Record<string, unknown> => parsed !== undefined);
}

/** Fake `Bun.RedisClient` (same shape as `bun-redis.test.ts`'s), extended with the `publish`/
 * `subscribe` surface adds. `createBestEffortEventBus` constructs two instances (publisher,
 * then subscriber) — tests grab them positionally off the static registry. */
class FakeRedisClient {
  static instances: FakeRedisClient[] = [];

  readonly connected = false;
  onconnect?: () => void;
  onclose?: (error?: Error) => void;
  onerror?: (error?: Error) => void;
  onMessage?: (message: string, channel: string) => void;
  shouldFailPublish = false;

  constructor(readonly url?: string) {
    FakeRedisClient.instances.push(this);
  }
  connect(): Promise<void> {
    return Promise.resolve();
  }
  close(): void {
    // nothing to release — the fake never connects
  }
  send(): Promise<unknown> {
    return Promise.resolve(undefined);
  }
  get(): Promise<string | null> {
    return Promise.resolve(null);
  }
  smembers(): Promise<unknown[]> {
    return Promise.resolve([]);
  }
  incr(): Promise<number> {
    return Promise.resolve(0);
  }
  publish(_channel: string, _message: string): Promise<number> {
    if (this.shouldFailPublish) {
      return Promise.reject(new Error('ECONNREFUSED (fake)'));
    }
    return Promise.resolve(1);
  }
  subscribe(
    _channel: string,
    callback: (message: string, channel: string) => void,
  ): Promise<number> {
    this.onMessage = callback;
    return Promise.resolve(1);
  }
}

async function withFakeBun<T>(fn: () => Promise<T>): Promise<T> {
  const bunGlobal = globalThis as unknown as { Bun?: unknown };
  const had = bunGlobal.Bun;
  FakeRedisClient.instances = [];
  bunGlobal.Bun = { RedisClient: FakeRedisClient };
  try {
    return await fn();
  } finally {
    if (had === undefined) {
      delete bunGlobal.Bun;
    } else {
      bunGlobal.Bun = had;
    }
  }
}

const WIDGET_ID = '2f6b6f2a-9b3a-4a3a-8b3a-9b3a4a3a8b3a';
function widgetProcessed(widgetId: string = WIDGET_ID): TestEvent {
  return { type: TEST_EVENT_TYPE.WidgetProcessed, widgetId };
}

function testBus(): ReturnType<typeof createBestEffortEventBus<TestEvent>> {
  return createBestEffortEventBus<TestEvent>({
    connection: { redisUrl: 'redis://fake' },
    schema: testEventSchema,
  });
}

describe('BestEffortEventBus.publish: never rejects', () => {
  it('Redis down: resolves; warns once per interval carrying suppressedCount', async () => {
    await withFakeBun(async () => {
      const bus = testBus();
      const [publisherFake] = FakeRedisClient.instances;
      // biome-ignore lint/style/noNonNullAssertion: constructed synchronously above
      publisherFake!.shouldFailPublish = true;

      const capture = captureStdout();
      await expect(bus.publish(widgetProcessed())).resolves.toBeUndefined();
      await expect(bus.publish(widgetProcessed())).resolves.toBeUndefined();
      capture.restore();

      const failureLines = jsonLines(capture.lines).filter((line) =>
        String(line.msg).includes('publish failed'),
      );
      // First failure logs; the second (same interval) is suppressed — never fully silent, but
      // never noisy either.
      expect(failureLines).toHaveLength(1);
      expect(failureLines[0]).toMatchObject({ suppressedCount: 0, queue: 'widget.processed' });

      await bus.close();
    });
  });
});

describe('BestEffortEventBus consume boundary', () => {
  it('invalid JSON payload is swallowed via failSpan (no throw, one terminal log)', async () => {
    await withFakeBun(async () => {
      const bus = testBus();
      await bus.start();
      const subscriberFake = FakeRedisClient.instances[1];

      const capture = captureStdout();
      // biome-ignore lint/style/noNonNullAssertion: start() always registers onMessage
      subscriberFake!.onMessage!('not json{{{', 'bus:events:v1');
      await new Promise((resolve) => setTimeout(resolve, 10));
      capture.restore();

      const lines = jsonLines(capture.lines);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ code: 'VALIDATION' });
      await bus.close();
    });
  });

  it('schema-invalid event is swallowed via failSpan (no throw, one terminal log)', async () => {
    await withFakeBun(async () => {
      const bus = testBus();
      await bus.start();
      const subscriberFake = FakeRedisClient.instances[1];

      const capture = captureStdout();
      // biome-ignore lint/style/noNonNullAssertion: start() always registers onMessage
      subscriberFake!.onMessage!(
        JSON.stringify({ event: { type: 'widget.deleted' } }),
        'bus:events:v1',
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      capture.restore();

      const lines = jsonLines(capture.lines);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ code: 'VALIDATION' });
      await bus.close();
    });
  });

  it('a delivered type with no registered handler logs nothing and does not throw', async () => {
    await withFakeBun(async () => {
      const bus = testBus();
      await bus.start();
      const subscriberFake = FakeRedisClient.instances[1];

      const capture = captureStdout();
      // biome-ignore lint/style/noNonNullAssertion: start() always registers onMessage
      subscriberFake!.onMessage!(JSON.stringify({ event: widgetProcessed() }), 'bus:events:v1');
      await new Promise((resolve) => setTimeout(resolve, 10));
      capture.restore();

      expect(jsonLines(capture.lines)).toHaveLength(0);
      await bus.close();
    });
  });

  it('a throwing handler is swallowed (no throw, one terminal log) and does not stop later handlers', async () => {
    await withFakeBun(async () => {
      const bus = testBus();
      const calls: string[] = [];
      bus.subscribe(TEST_EVENT_TYPE.WidgetProcessed, () => {
        calls.push('first');
        throw new Error('handler boom');
      });
      bus.subscribe(TEST_EVENT_TYPE.WidgetProcessed, () => {
        calls.push('second');
        return Promise.resolve();
      });
      await bus.start();
      const subscriberFake = FakeRedisClient.instances[1];

      const capture = captureStdout();
      // biome-ignore lint/style/noNonNullAssertion: start() always registers onMessage
      subscriberFake!.onMessage!(JSON.stringify({ event: widgetProcessed() }), 'bus:events:v1');
      await new Promise((resolve) => setTimeout(resolve, 10));
      capture.restore();

      // sequential, both ran (the first's throw did not stop the second)
      expect(calls).toStrictEqual(['first', 'second']);
      const lines = jsonLines(capture.lines);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.msg).toBe('messaging.bus: handler failed');
      await bus.close();
    });
  });
});
