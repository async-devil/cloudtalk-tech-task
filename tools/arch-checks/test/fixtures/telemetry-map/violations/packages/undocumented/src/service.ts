import { createModuleObservability } from '@repo/observability';

const obs = createModuleObservability('undocumented');

export async function run(): Promise<void> {
  await obs.withSpan('undocumented.widget.create', async () => undefined);
}
