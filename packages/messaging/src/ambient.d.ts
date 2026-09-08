/**
 * Minimal hand-written ambient declarations for the Bun-native Redis client this package's
 * internal transport wrapper uses (no `bun-types` — no registry entry, following the pattern in
 * `apps/api/src/ambient.d.ts` / `tools/arch-checks/src/ambient.d.ts`). Scoped exactly to the
 * shape BullMQ's own `createBunRedisClient` adapter requires of the raw client
 * (`BunRedisRawClient` in `bullmq`'s typings): `connected`, the callback hooks, `connect`/
 * `close`, and the handful of commands the adapter forwards directly rather than through
 * `send`.
 *
 * Hand-written ambients are the ruled decision, NOT an oversight (ADR-0003 §6): the dependency
 * registry admits no dependency without an entry, and a `bun-types` entry would license the entire
 * Bun surface everywhere — runtime-API sprawl the "modules survive extraction" law (ADR-0001)
 * exists to catch. This declaration is minimal and lists only the client shape BullMQ's adapter
 * actually requires, PLUS the `send`/`publish`/`subscribe` surface the token-bucket
 * limiter and `BestEffortEventBus` use directly against their own raw clients (verified by hand
 * against Bun 1.3.14): `send('EVAL', …)`
 * for the Lua script (no dedicated `eval` method on `Bun.RedisClient`), and native pub/sub.
 */

declare namespace Bun {
  class RedisClient {
    constructor(url?: string, options?: Record<string, unknown>);
    /** NOT provided by Bun — an expando OUR wrapper sets so BullMQ's adapter (which reads
     * `raw.url` when duplicating/reconnecting) targets the configured Redis, not Bun's default.
     * See internal/bun-redis.ts. */
    url?: string;
    readonly connected: boolean;
    onconnect?: () => void;
    onclose?: (error?: Error) => void;
    onerror?: (error?: Error) => void;
    connect(): Promise<void>;
    close(): void;
    send<T = unknown>(command: string, args: unknown[]): Promise<T>;
    get(key: string): Promise<string | null | undefined>;
    smembers(key: string): Promise<unknown[] | null | undefined>;
    incr(key: string): Promise<number>;
    /** Returns the number of clients that received the message (verified). */
    publish(channel: string, message: string): Promise<number>;
    /** `callback(message, channel)` — argument order verified by hand against Bun 1.3.14;
     * fires for every message on `channel` until `close()`. Returns the subscription count. */
    subscribe(
      channel: string,
      callback: (message: string, channel: string) => void,
    ): Promise<number>;
  }
}

declare const Bun: typeof Bun;
