import { ConfigError, composeConfig } from '@repo/config';
import { describe, expect, it } from 'vitest';
import { configSlice } from '../src/index.js';

interface Composed {
  observability: {
    OTEL_EXPORTER_OTLP_ENDPOINT: string;
    OTEL_SERVICE_NAME: string;
    OTEL_SERVICE_NAMESPACE: string;
    DEPLOYMENT_ENVIRONMENT: string;
    LOG_LEVEL: string;
  };
}

function source(values: Record<string, string>) {
  return { name: 'test', load: () => Promise.resolve(values) };
}

describe('observability config slice', () => {
  it('applies test-mode defaults for every key', async () => {
    const { config } = await composeConfig<Composed>({
      mode: 'test',
      slices: [configSlice],
      sources: [source({})],
    });
    expect(config.observability).toEqual({
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
      OTEL_SERVICE_NAME: 'api',
      OTEL_SERVICE_NAMESPACE: 'reviews',
      DEPLOYMENT_ENVIRONMENT: 'dev',
      LOG_LEVEL: 'info',
    });
  });

  it('a fail-closed tier requires endpoint and environment (both listed)', async () => {
    const attempt = composeConfig<Composed>({
      mode: 'production',
      slices: [configSlice],
      sources: [source({})],
    });
    await expect(attempt).rejects.toThrow(ConfigError);
    const err = await attempt.catch((e: unknown) => e as ConfigError);
    const keys = err.issues.map((issue) => issue.key);
    expect(keys).toContain('OTEL_EXPORTER_OTLP_ENDPOINT');
    expect(keys).toContain('DEPLOYMENT_ENVIRONMENT');
  });

  it('rejects an out-of-set LOG_LEVEL (no pino trace level — ADR-0009)', async () => {
    await expect(
      composeConfig<Composed>({
        mode: 'test',
        slices: [configSlice],
        sources: [source({ LOG_LEVEL: 'trace' })],
      }),
    ).rejects.toThrow(ConfigError);
  });
});
