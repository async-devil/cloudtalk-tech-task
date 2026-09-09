import { createModuleObservability } from '@repo/observability';

const obs = createModuleObservability('stale');

export async function run(): Promise<void> {
  await obs.withSpan('stale.widget.create', async () => undefined);
}
