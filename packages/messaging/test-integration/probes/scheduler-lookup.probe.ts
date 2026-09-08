/**
 * 's amendment item 2 probe: `getRegisteredSchedulerIds`. Run as a real Bun
 * process against a real Redis (harness/spawn-probe.ts). Proves the one fact static reading of
 * BullMQ's source cannot substitute for: a scheduler registered via the real
 * `scheduleRepeatable` -> `upsertJobScheduler` path is found by ITS OWN `schedulerId` — the
 * `key`-not-`id` mapping `repeatable.ts`'s `getRegisteredSchedulerIds` documents. Matching on
 * `id` instead (BullMQ's `JobSchedulerJson.id`, which the modern registration path never
 * populates) would make this assertion fail, which is exactly the mutation this probe is written
 * to catch.
 */

import process from 'node:process';
import { getRegisteredSchedulerIds, scheduleRepeatable } from '@repo/messaging';

const redisUrl = process.env.REDIS_URL;
if (redisUrl === undefined) {
  throw new Error('scheduler-lookup probe: REDIS_URL is required');
}
const connection = { redisUrl };
const stage = 'probe-scheduler-lookup-stage';
const schedulerId = 'probe-scheduler-lookup-id';

async function main(): Promise<void> {
  await scheduleRepeatable({
    stage,
    connection,
    schedulerId,
    every: { milliseconds: 60_000 },
    data: {},
  });

  const registered = await getRegisteredSchedulerIds({ stage, connection });
  // A never-registered stage: proves an empty result reads as an empty SET, not an error/garbage
  // value that would happen to satisfy a naive truthy check.
  const neverRegistered = await getRegisteredSchedulerIds({
    stage: 'probe-scheduler-lookup-empty-stage',
    connection,
  });

  process.stdout.write(
    `${JSON.stringify({
      includesRegistered: registered.has(schedulerId),
      includesBogus: registered.has('never-registered-scheduler-id'),
      emptyStageSize: neverRegistered.size,
    })}\n`,
  );
}

await main();
