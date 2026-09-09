/**
 * Testcontainers `redis:8-alpine` for the integration probes (
 * ). Docker-host autodetect duplicated (not imported) from `apps/api/test/harness/containers.ts`
 * per that spec's own note: lifting it into a shared location would add a new workspace edge
 * (messaging has no reason to depend on apps/api or vice versa) — this ~30-line block is the
 * accepted alternative, pointer comment included. See that file for the full colima/Ryuk
 * reasoning (registry pitfall, docs/trusted-code-sources.md row 85); this is a verbatim copy of
 * its `autodetectDockerHost`.
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
  stop(): Promise<void>;
}

/** Starts `redis:8-alpine` ('s own image choice) once per suite file. Generous startup
 * timeout (ADR-0010): first-run image pulls plus colima's port-forwarder add real latency. */
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
    async stop(): Promise<void> {
      await redis.stop();
    },
  };
}
