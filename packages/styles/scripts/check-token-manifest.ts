/**
 * Manifest freshness — regenerate and diff, the shape
 * `apps/app/scripts/check-route-tree.ts` and `apps/api`'s `env-example-check` already use.
 *
 * WHY THIS IS THE WHOLE RECONCILIATION. The generator's output is a pure function of
 * `src/tokens/*.css`, so comparing the committed manifest against a fresh generation catches BOTH
 * directions ADR-0012 asks for in one check: a token added to the CSS with no manifest entry,
 * and a manifest entry naming a token that no longer exists, are the same dirty diff. There is no
 * third state to test for.
 *
 * It also makes the manifest un-editable in practice: a hand edit is reverted by the next
 * generation and fails this gate in the meantime, which is what "GENERATED — DO NOT EDIT" needs in
 * order to be true rather than aspirational.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { collectTokens, renderManifest } from './generate-token-manifest.ts';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const TOKENS_DIR = path.join(PACKAGE_ROOT, 'src', 'tokens');
const MANIFEST_PATH = path.join(TOKENS_DIR, 'manifest.ts');

function main(): number {
  if (!existsSync(MANIFEST_PATH)) {
    console.error(
      'token-manifest-check: src/tokens/manifest.ts does not exist. Run ' +
        '`moon run styles:token-manifest`. A missing manifest disarms every gate rule that reads ' +
        'it, so its absence is a failure rather than a no-op (rule 0).',
    );
    return 1;
  }

  const committed = readFileSync(MANIFEST_PATH, 'utf8');
  const expected = renderManifest(collectTokens(TOKENS_DIR));

  if (committed === expected) {
    console.log('token-manifest-check: manifest is in sync with src/tokens/*.css.');
    return 0;
  }

  console.error(
    'token-manifest-check: src/tokens/manifest.ts is STALE — it disagrees with src/tokens/*.css.\n' +
      'Run `moon run styles:token-manifest` and commit the result.\n' +
      'This fires in both directions by construction: a token declared in CSS with no manifest ' +
      'entry, and a manifest entry naming no real token, are the same diff.',
  );
  return 1;
}

if (import.meta.main) {
  process.exit(main());
}
