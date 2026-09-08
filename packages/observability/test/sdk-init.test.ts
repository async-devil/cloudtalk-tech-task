import { InternalError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import { initObservability } from '../src/sdk.js';

const base = {
  serviceName: 'test-svc',
  serviceVersion: '0.0.0',
  serviceNamespace: 'reviews',
  deploymentEnvironment: 'test',
} as const;

describe('initObservability (ADR-0009, INV-10: SDK wired exactly once)', () => {
  it('a fail-closed tier (production) without an OTLP endpoint refuses to start', () => {
    expect(() => initObservability({ ...base, mode: 'production' })).toThrow(InternalError);
  });

  it('starts exporter-less in test mode, refuses a second init, restarts after shutdown', async () => {
    const handle = initObservability({ ...base, mode: 'test' });
    expect(() => initObservability({ ...base, mode: 'test' })).toThrow(InternalError);
    await handle.shutdown();
    const second = initObservability({ ...base, mode: 'test' });
    await second.shutdown();
  });

  // INV-12 (ADR-0009): the exemplar-strategy seam. `collector-spanmetrics` is the live default;
  // `sdk-native` throws until @opentelemetry/sdk-metrics can emit exemplars — this test is the
  // tripwire that must be updated (to a working assertion) the day that swap is implemented.
  it('defaults to collector-spanmetrics; sdk-native throws until the SDK supports it', async () => {
    const handle = initObservability({ ...base, mode: 'test' });
    await handle.shutdown();

    expect(() =>
      initObservability({ ...base, mode: 'test', exemplarStrategy: 'sdk-native' }),
    ).toThrow(InternalError);
  });
});
