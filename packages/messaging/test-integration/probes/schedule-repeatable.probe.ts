/**
 * Probe: `scheduleRepeatable` idempotency. Run as a real Bun process against a real Redis
 * (harness/spawn-probe.ts). Registers the same `schedulerId` twice with different `every` values
 * and asserts exactly one scheduler exists, carrying the SECOND configuration.
 */

import process from 'node:process';
import { scheduleRepeatable } from '@repo/messaging';
import { Queue } from 'bullmq';

const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined) {
  throw new Error('schedule-repeatable probe: REDIS_URL is required');
}
const connection = { redisUrl };
const stage = 'probe-repeatable-stage';
const schedulerId = 'probe-scheduler';

async function main(): Promise<void> {
  await scheduleRepeatable({
    stage,
    connection,
    schedulerId,
    every: { milliseconds: 60_000 },
    data: { revision: 1 },
  });
  await scheduleRepeatable({
    stage,
    connection,
    schedulerId,
    every: { milliseconds: 5_000 },
    data: { revision: 2 },
  });

  const url = new URL(redisUrl);
  const queue = new Queue(stage, { connection: { host: url.hostname, port: Number(url.port) } });
  try {
    const schedulers = await queue.getJobSchedulers();
    const scheduler = await queue.getJobScheduler(schedulerId);
    process.stdout.write(
      `${JSON.stringify({
        schedulerCount: schedulers.length,
        every: scheduler?.every ?? null,
      })}\n`,
    );
  } finally {
    await queue.close();
  }
}

await main();
