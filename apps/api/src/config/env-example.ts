/**
 * `moon run api:env-example [-- --write]`: renders `.env.example` from the composed config slice
 * schemas' `.describe()` annotations and either writes it (`--write`, the one sanctioned way to
 * change the committed file — hand edits are what this check exists to catch) or diffs it against
 * the committed file and exits 1 on drift (the mode `api:env-example-check` runs in CI).
 */

import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { renderEnvExample } from '@repo/config';
import { APP_CONFIG_SLICES } from './index.js';
import { SPA_ENV_DOCUMENTATION } from './spa-env-documentation.js';

const ENV_EXAMPLE_PATH = fileURLToPath(new URL('../../../../.env.example', import.meta.url));

async function main(): Promise<void> {
  // The SPA's key is documentation-only (see `spa-env-documentation.ts`): it belongs in this
  // file, and no config slice parses it.
  const rendered = renderEnvExample(APP_CONFIG_SLICES, [SPA_ENV_DOCUMENTATION]);

  if (process.argv.includes('--write')) {
    await writeFile(ENV_EXAMPLE_PATH, rendered, 'utf8');
    process.stdout.write(`env-example: wrote ${ENV_EXAMPLE_PATH}\n`);
    return;
  }

  const committed = await readFile(ENV_EXAMPLE_PATH, 'utf8');
  if (committed === rendered) {
    process.stdout.write('env-example: .env.example is up to date\n');
    return;
  }

  process.stderr.write(
    'env-example: .env.example is out of date — run `moon run api:env-example -- --write`\n\n',
  );
  printLineDiff(committed, rendered);
  process.exit(1);
}

/** No diff library (dependency registry constraint) — a plain line-indexed comparison is enough
 * to show a reviewer exactly what changed; these files are short and hand-generated. */
function printLineDiff(committed: string, rendered: string): void {
  const committedLines = committed.split('\n');
  const renderedLines = rendered.split('\n');
  const lineCount = Math.max(committedLines.length, renderedLines.length);

  for (let index = 0; index < lineCount; index += 1) {
    const before = committedLines[index];
    const after = renderedLines[index];
    if (before === after) {
      continue;
    }
    if (before !== undefined) {
      process.stderr.write(`- ${before}\n`);
    }
    if (after !== undefined) {
      process.stderr.write(`+ ${after}\n`);
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`env-example: ${String(error)}\n`);
  process.exit(1);
});
