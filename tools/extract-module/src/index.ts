/**
 * `bun run extract-module <name>` / `bun run extract-module --all` — the ADR-0001 point-3
 * autonomy-contract CLI. `<name>` is a folder name under `packages/*` or `tools/*` (apps are
 * never extraction targets — ADR-0001's named exception). `--all` runs the full matrix over every
 * `liftable`-tagged package; per-PR CI instead runs the affected-only pass — see
 * `extract-changed.ts` and `extract-module-changed` in the root `moon.yml`.
 */
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { type ExtractionResult, extractModule } from './extract.js';
import { discoverWorkspace, liftablePackages } from './workspace.js';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..', '..', '..');

function printResult(result: ExtractionResult): void {
  if (result.success) {
    // The honesty rule: an extraction that ran no tests must never print the same as one that
    // did — see `extract.ts`'s `ExtractionResult.ranTests`.
    const suffix = result.ranTests ? '' : ' (build-only)';
    console.log(`extract-module: PASS "${result.folderName}"${suffix}`);
    return;
  }
  console.error(
    `extract-module: FAIL "${result.folderName}": ${result.failureDetail ?? 'unknown failure'}`,
  );
  if (result.tempDir !== undefined) {
    console.error(`  left for inspection: ${result.tempDir}`);
  }
}

function main(): number {
  const args = process.argv.slice(2);

  if (args.length === 1 && args[0] === '--all') {
    const workspace = discoverWorkspace(REPO_ROOT);
    const targets = liftablePackages(workspace);
    console.log(`extract-module --all: ${targets.length} liftable package(s)`);
    let allPassed = true;
    for (const target of targets) {
      const result = extractModule(target.folderName, { repoRoot: REPO_ROOT });
      printResult(result);
      allPassed = allPassed && result.success;
    }
    return allPassed ? 0 : 1;
  }

  if (args.length === 1 && args[0] !== undefined && !args[0].startsWith('-')) {
    const result = extractModule(args[0], { repoRoot: REPO_ROOT });
    printResult(result);
    return result.success ? 0 : 1;
  }

  console.error('usage: extract-module <name> | extract-module --all');
  return 2;
}

process.exit(main());
