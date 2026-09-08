import { readFile } from 'node:fs/promises';
import { parseDotenv } from './internal/dotenv.js';

/** A named source of raw env-shaped key/value pairs, resolved before validation (ADR-0005). */
export interface ConfigSource {
  readonly name: string;
  load(): Promise<Record<string, string>>;
}

/**
 * Parses a dotenv-format file at `path`. A missing file yields an empty map, not an error — boot
 * may legitimately run file-less (staging/production, where the composition root only includes
 * this source in `test` mode in the first place).
 */
export function envFileSource(path: string): ConfigSource {
  return {
    name: `env-file(${path})`,
    load: async () => {
      let content: string;
      try {
        content = await readFile(path, 'utf8');
      } catch (error) {
        if (isEnoent(error)) {
          return {};
        }
        throw error;
      }
      return parseDotenv(content);
    },
  };
}

/** Wraps `process.env` (or any equivalent map) as a {@link ConfigSource}, dropping `undefined`
 * entries. The composition root passes `process.env` in — this package never reads it directly
 * (ADR-0005: "no reads outside the config module"). */
export function processEnvSource(env: Record<string, string | undefined>): ConfigSource {
  return {
    name: 'process-env',
    load: () => {
      const result: Record<string, string> = {};
      for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
          result[key] = value;
        }
      }
      return Promise.resolve(result);
    },
  };
}

/** Node's file-not-found error shape (a missing `.env` file is not a config error). */
function isEnoent(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code: unknown }).code === 'ENOENT'
  );
}
