import { createModuleObservability } from '@repo/observability';

const obs = createModuleObservability('unspecified');

export async function run(): Promise<void> {
  await obs.withSpan('unspecified.widget.create', async () => undefined);
}
