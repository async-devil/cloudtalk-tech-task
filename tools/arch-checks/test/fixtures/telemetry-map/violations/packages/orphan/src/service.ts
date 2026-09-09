import { createModuleObservability } from '@repo/observability';

const obs = createModuleObservability('orphan');

/** A telemetry-shaped `name:` the checker cannot classify: no allowedAttributes anywhere near
 * this property. */
export const ORPHAN_SPECIFICATION = {
  name: 'orphan.widget.create',
  description: 'no allowedAttributes anywhere near this property',
};

export async function run(): Promise<void> {
  await obs.withSpan('orphan.widget.create', async () => undefined);
}
