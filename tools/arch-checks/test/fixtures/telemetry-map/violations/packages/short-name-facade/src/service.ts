import { createModuleObservability } from '@repo/observability';

/** Fixture: a module whose FACADE name is deliberately shorter than its package folder — the
 * same shape a carried module can freeze when its telemetry namespace is meant to be shorter
 * than the workspace folder name. Guards `emittedFacadePrefix`: if prefix derivation regressed to
 * the folder name, no `short.*` record name would be collected and this module's rule-5
 * violation would vanish silently. */
const obs = createModuleObservability('short');

export async function run(): Promise<void> {
  await obs.withSpan('short.widget.create', async () => undefined);
}
