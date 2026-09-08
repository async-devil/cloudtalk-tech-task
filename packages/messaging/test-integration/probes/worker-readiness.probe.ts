/**
 * 's amendment item 2 probe: `WorkerHandle.isReady()`. Run as a real Bun process
 * against a real Redis (harness/spawn-probe.ts — `createWorker` reaches Bun's global Redis
 * client). Proves the one fact a fake/unit test cannot: a worker whose connection came up cleanly
 * still has to report `false` once `close()` runs — `Worker.isRunning()` flips, not
 * `Worker.waitUntilReady()` alone, which is exactly why `isReady()` checks both.
 */

import process from 'node:process';
import { createWorker } from '@repo/messaging';
import { z } from 'zod';

const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined) {
  throw new Error('worker-readiness probe: REDIS_URL is required');
}
const connection = { redisUrl };
const stage = 'probe-worker-readiness-stage';
const schema = z.object({ marker: z.string() });

async function main(): Promise<void> {
  const worker = createWorker<{ readonly marker: string }>({
    stage,
    pipeline: 'probe',
    connection,
    schema,
    handler: async () => undefined,
  });

  const readyBeforeClose = await worker.isReady();
  await worker.close();
  const readyAfterClose = await worker.isReady();

  process.stdout.write(`${JSON.stringify({ readyBeforeClose, readyAfterClose })}\n`);
}

await main();
