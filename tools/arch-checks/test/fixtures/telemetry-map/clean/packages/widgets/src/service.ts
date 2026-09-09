import { createModuleObservability, METRIC_ATTRIBUTE } from '@repo/observability';

const obs = createModuleObservability('widgets');

/** The clean case: a span and an instrument, both documented in the README. */
const createCounter = obs.createCounter({
  name: 'widgets.widget.create',
  allowedAttributes: [METRIC_ATTRIBUTE.Outcome],
});

/** Renamed post-freeze: the README line carries the amendment marker that records it. */
const purgeCounter = obs.createCounter({
  name: 'widgets.widget.purge',
  allowedAttributes: [METRIC_ATTRIBUTE.Outcome],
});

export async function createWidget(): Promise<void> {
  await obs.withSpan('widgets.widget.create', async () => {
    createCounter.add(1);
    purgeCounter.add(1);
  });
}
