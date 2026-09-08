import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  type ConfigSource,
  composeConfig,
  defineConfigSlice,
  processEnvSource,
} from '../src/index.js';

function sourceFrom(name: string, values: Record<string, string>): ConfigSource {
  return { name, load: () => Promise.resolve(values) };
}

const slice = defineConfigSlice('api', () => z.object({ KEY: z.string() }));

describe('layered precedence: env-file < process env', () => {
  it('process env wins over the file source when both supply the same key', async () => {
    const fileSource = sourceFrom('env-file(.env)', { KEY: 'from-file' });
    const envSource = processEnvSource({ KEY: 'from-process-env' });

    const { config, report } = await composeConfig<{ api: { KEY: string } }>({
      mode: 'test',
      slices: [slice],
      sources: [fileSource, envSource],
    });

    expect(config.api.KEY).toBe('from-process-env');
    expect(report).toContainEqual({ key: 'KEY', source: 'process-env' });
  });

  it('falls back to the file source when process env supplies nothing', async () => {
    const fileSource = sourceFrom('env-file(.env)', { KEY: 'from-file' });
    const envSource = processEnvSource({});

    const { config, report } = await composeConfig<{ api: { KEY: string } }>({
      mode: 'test',
      slices: [slice],
      sources: [fileSource, envSource],
    });

    expect(config.api.KEY).toBe('from-file');
    expect(report).toContainEqual({ key: 'KEY', source: 'env-file(.env)' });
  });
});
