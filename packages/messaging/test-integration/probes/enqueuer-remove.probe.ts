/**
 * probe: `Enqueuer.remove` (the additive amendment the reconciler's remove-then-
 * re-add depends on, ADR-0007). Run as a real Bun process against a real Redis
 * (harness/spawn-probe.ts — `createQueue` reaches Bun's global Redis client). No worker is
 * started, so an enqueued job stays in BullMQ's `waiting` state and `remove` has something real
 * to remove.
 */

import process from 'node:process';
import { createQueue } from '@repo/messaging';

const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined) {
  throw new Error('enqueuer-remove probe: REDIS_URL is required');
}
const connection = { redisUrl };
const stage = 'probe-remove-stage';

async function main(): Promise<void> {
  const enqueuer = createQueue<{ readonly marker: string }>({ stage, connection });
  try {
    await enqueuer.enqueue('entity-present', { marker: 'one' });

    const removedExisting = await enqueuer.remove('entity-present');
    const removedAgain = await enqueuer.remove('entity-present');
    const removedNeverEnqueued = await enqueuer.remove('entity-never-enqueued');

    process.stdout.write(
      `${JSON.stringify({ removedExisting, removedAgain, removedNeverEnqueued })}\n`,
    );
  } finally {
    await enqueuer.close();
  }
}

await main();
