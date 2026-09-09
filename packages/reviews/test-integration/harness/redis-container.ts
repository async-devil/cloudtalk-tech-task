/**
 * Testcontainers `redis:8-alpine` for TASK-0005's outbox-relay durability proofs
 * (`outbox-relay-durability.test.ts`) — the ones that need a real BullMQ-backed
 * `startOutboxRelay` schedule, not just `relayOutboxBatch` against Postgres alone. Docker-host
 * autodetect duplicated (not imported) from `packages/messaging/test-integration/harness/
 * redis-container.ts` / `packages/jobs/test-integration/harness/postgres-container.ts` / this
 * package's own `postgres-container.ts` — per those files' own note: lifting this ~30-line block
 * into a shared location would add a new workspace edge for it, and this package has as little
 * reason to depend on `messaging`'s test harness as `messaging` has to depend on this one's.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import process from 'node:process';
import { GenericContainer, Wait } from 'testcontainers';

function autodetectDockerHost(): void {
  if (process.env.DOCKER_HOST !== undefined) {
    return;
  }
  const profile = process.env.COLIMA_PROFILE ?? 'default';
  const colimaSocket = `${homedir()}/.colima/${profile}/docker.sock`;
  if (!existsSync(colimaSocket)) {
    return;
  }
  process.env.DOCKER_HOST = `unix://${colimaSocket}`;
  if (process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE === undefined) {
    process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE = '/var/run/docker.sock';
  }
}

export interface RedisInfra {
  readonly redisUrl: string;
  /**
   * Runs `redis-cli FLUSHALL` INSIDE the container (`StartedTestContainer.exec`) rather than
   * connecting a Redis client from this package — this package has no sanctioned reason to import
   * `ioredis` (`SDK_OWNERS` in `tools/arch-checks/src/module-registry.cjs` confines it to
   * `packages/messaging`, and that rule applies to `test-integration/` exactly as it does to
   * `src/`; `depcruise` scans the whole package tree, not just `src/`). `redis:8-alpine` ships
   * `redis-cli` in the same image, so this needs no new dependency at all — a real flush against
   * the real container, proven by the durability test that reads Postgres afterward, not a stub.
   */
  flushAll(): Promise<void>;
  stop(): Promise<void>;
}

/** Starts `redis:8-alpine` once per suite file. Generous startup timeout (ADR-0010): first-run
 * image pulls plus colima's port-forwarder add real latency — matches
 * `packages/messaging/test-integration/harness/redis-container.ts`'s own constant. */
export async function startRedisInfra(): Promise<RedisInfra> {
  autodetectDockerHost();

  const redis = await new GenericContainer('redis:8-alpine')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage('Ready to accept connections'))
    .withStartupTimeout(120_000)
    .start();

  const redisUrl = `redis://${redis.getHost()}:${redis.getMappedPort(6379)}`;

  return {
    redisUrl,
    async flushAll(): Promise<void> {
      const result = await redis.exec(['redis-cli', 'FLUSHALL']);
      if (result.exitCode !== 0) {
        throw new Error(
          `redis-container: FLUSHALL failed (exit ${result.exitCode}): ${result.output}`,
        );
      }
    },
    async stop(): Promise<void> {
      await redis.stop();
    },
  };
}
