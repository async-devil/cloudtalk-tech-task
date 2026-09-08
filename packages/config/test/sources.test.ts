import { describe, expect, it } from 'vitest';
import { envFileSource, processEnvSource } from '../src/index.js';

const fixturePath = new URL('./fixtures/sample.env', import.meta.url).pathname;
const missingPath = new URL('./fixtures/does-not-exist.env', import.meta.url).pathname;

describe('envFileSource', () => {
  it('parses a real dotenv file end to end', async () => {
    const source = envFileSource(fixturePath);
    expect(source.name).toBe(`env-file(${fixturePath})`);
    const loaded = await source.load();
    expect(loaded).toEqual({
      FOO: 'bar',
      QUOTED: 'hello world',
      SINGLE_QUOTED: 'hello single',
      EMPTY: '',
      SPACED_KEY: 'value with spaces',
    });
  });

  it('returns an empty map when the file is missing (boot may run file-less)', async () => {
    const source = envFileSource(missingPath);
    await expect(source.load()).resolves.toEqual({});
  });
});

describe('processEnvSource', () => {
  it('drops undefined entries and keeps only string values', async () => {
    const source = processEnvSource({ FOO: 'bar', UNSET: undefined, BAZ: '' });
    expect(source.name).toBe('process-env');
    await expect(source.load()).resolves.toEqual({ FOO: 'bar', BAZ: '' });
  });
});
