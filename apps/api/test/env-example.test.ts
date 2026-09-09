/**
 * spec — the `.env.example` sync check, at the unit level (the moon task `env-example-
 * check` in `apps/api/moon.yml` runs the exact same generator as a CI gate): renders
 * `.env.example` from `APP_CONFIG_SLICES` (the same slice list the composition root boots with)
 * and byte-diffs it against the committed file. Supersedes the key-set-only drift test
 * (removed in this same PR, ): the generator's own determinism now IS the guarantee,
 * rather than a separate schema/file key-set comparison.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { renderEnvExample } from '@repo/config';
import { describe, expect, it } from 'vitest';
import { APP_CONFIG_SLICES } from '../src/config/index.js';
import { SPA_ENV_DOCUMENTATION } from '../src/config/spa-env-documentation.js';

const ENV_EXAMPLE_PATH = fileURLToPath(new URL('../../../.env.example', import.meta.url));
/** Read as TEXT, never imported: `apps/api` may not depend on `apps/app` (apps are leaves,
 * ADR-0001). A filesystem read is not a dependency edge. */
const SPA_API_MODULE_PATH = fileURLToPath(
  new URL('../../app/src/shared/api/index.ts', import.meta.url),
);

/** The exact argument list `src/config/env-example.ts` renders with — restated once, here, so the
 * suite cannot drift from the generator by testing a different composition than the one that
 * writes the file. */
function render(): string {
  return renderEnvExample(APP_CONFIG_SLICES, [SPA_ENV_DOCUMENTATION]);
}

describe('.env.example sync check', () => {
  it('the committed file is exactly what the generator produces', async () => {
    const committed = await readFile(ENV_EXAMPLE_PATH, 'utf8');
    expect(committed).toBe(render());
  });

  it('is byte-stable across repeated renders of the same inputs', () => {
    expect(render()).toBe(render());
  });
});

/**
 * / SO-4. `.env.example` is generated, and its `# apps/app` section is declared here
 * (`src/config/spa-env-documentation.ts`) because the generator lives here and apps may not import
 * each other. That leaves the SPA's fallback URL written in two files — a drift that nothing else
 * in the repo could notice, because no import connects them.
 *
 * This closes it by reading the SPA's source as text and comparing the two literals. It fails the
 * day someone changes one and not the other, which is the entire point.
 */
describe('the documented SPA default matches the SPA', () => {
  it('VITE_API_URL is documented in the generated file', async () => {
    const committed = await readFile(ENV_EXAMPLE_PATH, 'utf8');
    expect(committed).toContain('# --- apps/app ');
    expect(committed).toContain(
      `# VITE_API_URL=${SPA_ENV_DOCUMENTATION.entries[0]?.defaultValue ?? ''}`,
    );
  });

  it('and the documented default is the one apps/app actually falls back to', async () => {
    const source = await readFile(SPA_API_MODULE_PATH, 'utf8');
    const declared = /const DEFAULT_API_URL = '([^']+)'/.exec(source)?.[1];

    expect(declared).toBeDefined();
    expect(SPA_ENV_DOCUMENTATION.entries[0]?.defaultValue).toBe(declared);
  });
});
