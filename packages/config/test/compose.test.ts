import { InternalError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConfigError,
  type ConfigSource,
  composeConfig,
  defineConfigSlice,
  processEnvSource,
} from '../src/index.js';

function sourceFrom(name: string, values: Record<string, string>): ConfigSource {
  return { name, load: () => Promise.resolve(values) };
}

/** Awaits `promise`, expecting rejection, and hands the caught error back for the calling
 * `it()` block to assert on (biome's `noMisplacedAssertion` rejects `expect()` calls made
 * outside a test body, so this helper deliberately does not assert itself). */
async function captureRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the promise to reject');
}

describe('composeConfig', () => {
  it('fails closed listing ALL missing keys across ALL slices (a fail-closed tier)', async () => {
    const apiSlice = defineConfigSlice('api', () =>
      z.object({ PORT: z.string(), HOST: z.string() }),
    );
    const persistenceSlice = defineConfigSlice('persistence', () =>
      z.object({ DATABASE_URL: z.string() }),
    );

    const error = await captureRejection(
      composeConfig({
        mode: 'production',
        slices: [apiSlice, persistenceSlice],
        sources: [processEnvSource({})],
      }),
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.map((issue) => issue.key).sort()).toEqual([
      'DATABASE_URL',
      'HOST',
      'PORT',
    ]);
  });

  it('treats an empty-string value as absent (empty-string ⇒ undefined, pre-parse)', async () => {
    const slice = defineConfigSlice('api', () => z.object({ PORT: z.string() }));

    const error = await captureRejection(
      composeConfig({
        mode: 'test',
        slices: [slice],
        sources: [processEnvSource({ PORT: '' })],
      }),
    );

    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).issues.map((issue) => issue.key)).toEqual(['PORT']);
  });

  it('merges sources with later-wins precedence (process-env over file)', async () => {
    const slice = defineConfigSlice('api', () => z.object({ PORT: z.string() }));
    const fileSource = sourceFrom('env-file(.env)', { PORT: '3000' });
    const envSource = processEnvSource({ PORT: '4000' });

    const { config, report } = await composeConfig<{ api: { PORT: string } }>({
      mode: 'test',
      slices: [slice],
      sources: [fileSource, envSource],
    });

    expect(config.api.PORT).toBe('4000');
    expect(report).toContainEqual({ key: 'PORT', source: 'process-env' });
  });

  it('supports mode-aware requiredness (required only in fail-closed tiers)', async () => {
    const slice = defineConfigSlice('observability', (mode) =>
      z.object({
        OTEL_EXPORTER_OTLP_ENDPOINT: mode === 'production' ? z.string() : z.string().optional(),
      }),
    );

    await expect(
      composeConfig({ mode: 'test', slices: [slice], sources: [processEnvSource({})] }),
    ).resolves.toBeDefined();

    await expect(
      composeConfig({ mode: 'production', slices: [slice], sources: [processEnvSource({})] }),
    ).rejects.toBeInstanceOf(ConfigError);
  });

  it('report lists key names and winning sources, never values', async () => {
    const slice = defineConfigSlice('api', () =>
      z.object({ PORT: z.string(), SECRET: z.string() }),
    );

    const { report } = await composeConfig<{ api: { PORT: string; SECRET: string } }>({
      mode: 'test',
      slices: [slice],
      sources: [processEnvSource({ PORT: '3000', SECRET: 'super-secret-value' })],
    });

    expect(report).toEqual([
      { key: 'PORT', source: 'process-env' },
      { key: 'SECRET', source: 'process-env' },
    ]);
    expect(JSON.stringify(report)).not.toContain('super-secret-value');
  });

  it('reports "default" as the source for a key no source provided', async () => {
    const slice = defineConfigSlice('api', () => z.object({ PORT: z.string().default('3000') }));

    const { config, report } = await composeConfig<{ api: { PORT: string } }>({
      mode: 'test',
      slices: [slice],
      sources: [processEnvSource({})],
    });

    expect(config.api.PORT).toBe('3000');
    expect(report).toEqual([{ key: 'PORT', source: 'default' }]);
  });

  it('throws on duplicate slice keys, before resolving any source', async () => {
    let loadCount = 0;
    const countingSource: ConfigSource = {
      name: 'counting',
      load: () => {
        loadCount += 1;
        return Promise.resolve({});
      },
    };
    const sliceA = defineConfigSlice('api', () => z.object({ PORT: z.string().default('3000') }));
    const sliceB = defineConfigSlice('api', () =>
      z.object({ HOST: z.string().default('0.0.0.0') }),
    );

    await expect(
      composeConfig({ mode: 'test', slices: [sliceA, sliceB], sources: [countingSource] }),
    ).rejects.toBeInstanceOf(InternalError);
    expect(loadCount).toBe(0);
  });

  it('deep-freezes the composed config', async () => {
    const slice = defineConfigSlice('api', () => z.object({ PORT: z.string().default('3000') }));

    const { config } = await composeConfig<{ api: { PORT: string } }>({
      mode: 'test',
      slices: [slice],
      sources: [processEnvSource({})],
    });

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.api)).toBe(true);
    expect(() => {
      config.api.PORT = 'mutated';
    }).toThrow();
  });
});
