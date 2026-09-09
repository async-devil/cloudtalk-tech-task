import { createModuleObservability } from '@repo/observability';

const obs = createModuleObservability('nosection');

export async function run(): Promise<void> {
  await obs.withSpan('nosection.widget.create', async () => undefined);
}
