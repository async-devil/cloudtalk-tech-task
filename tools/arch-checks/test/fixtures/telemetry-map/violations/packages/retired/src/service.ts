import { createModuleObservability } from '@repo/observability';

const obs = createModuleObservability('retired');

export async function run(): Promise<void> {
  await obs.withSpan('retired.widget.create', async () => undefined);
}
