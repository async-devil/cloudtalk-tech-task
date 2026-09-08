import { type ConnectionOptions, createBunRedisClient } from 'bullmq';
import type { MessagingConnection } from '../connection.js';

/**
 * The one Redis client dependency repo-wide: BullMQ's documented Bun adapter over
 * Bun's native `Bun.RedisClient`, never `ioredis` (registry pitfall note, docs/trusted-code-sources.md).
 * A fresh raw client is created per BullMQ connection (`createQueue`/`createWorker` each get
 * their own) — BullMQ itself calls `duplicate()` on it internally for blocking/pubsub uses.
 */
export function bunRedisConnection(connection: MessagingConnection): ConnectionOptions {
  // `globalThis.Bun` (not bare `Bun`): biome's `noUndeclaredVariables` only recognizes the
  // browser/Node globals it ships with, not this repo's hand-written `Bun` ambient global
  // (src/ambient.d.ts) — routing through the always-recognized `globalThis` avoids adding a
  // repo-wide biome globals override for one call site.
  const raw = new globalThis.Bun.RedisClient(connection.redisUrl);
  // Bun's RedisClient does not expose the URL it was constructed with, but BullMQ's adapter
  // reads `this.raw.url` whenever it needs a NEW connection (its sync `duplicate()` for
  // blocking/pubsub uses, and reconnects) — without this expando, every duplicate silently
  // targets Bun's DEFAULT Redis (localhost:6379 / $REDIS_URL) instead of the configured one.
  // Harmless in dev-on-defaults; a wrong-database bug on any other host (e.g. Testcontainers'
  // random ports). Pinned by test/bun-redis.test.ts (INV-9).
  raw.url = connection.redisUrl;
  return createBunRedisClient(raw);
}
