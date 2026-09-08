import { describe, expect, it } from 'vitest';
import { bunRedisConnection } from '../src/internal/bun-redis.js';

// Vitest's module runner does not inject Bun's globals (verified at) — provide the exact
// raw-client shape BullMQ's adapter needs so the wrapper's URL handling can be pinned without a
// live Redis.
class FakeRedisClient {
  url?: string;
  readonly connected = false;
  onconnect?: () => void;
  onclose?: (error?: Error) => void;
  onerror?: (error?: Error) => void;
  constructor(readonly constructedWith?: string) {}
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
}

describe('bunRedisConnection (INV-9: configured URL survives BullMQ duplicate())', () => {
  it('sets raw.url so the adapter duplicates/reconnects to the CONFIGURED Redis', () => {
    const bunGlobal = globalThis as unknown as { Bun?: { RedisClient: unknown } };
    const hadBun = bunGlobal.Bun;
    bunGlobal.Bun = { RedisClient: FakeRedisClient };
    try {
      const url = 'redis://elsewhere:7777';
      const connection = bunRedisConnection({ redisUrl: url });
      // BullMQ's bun adapter reads `this.raw.url` for every duplicate()/reconnect; Bun's own
      // client never exposes it (verified against Bun 1.3.14), so the wrapper must set it.
      const raw = (connection as { raw?: { url?: string } }).raw;
      expect(raw?.url).toBe(url);
    } finally {
      if (hadBun === undefined) {
        delete bunGlobal.Bun;
      } else {
        bunGlobal.Bun = hadBun;
      }
    }
  });
});
