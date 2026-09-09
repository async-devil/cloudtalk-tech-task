/**
 * The route-tree codegen-freshness gate ("regenerate and diff"), the exact shape `apps/api`'s
 * `env-example-check` uses: the generator is the only writer, and this check re-runs it and
 * compares.
 *
 * WHAT IT PROTECTS. `src/routeTree.gen.ts` is committed source that nothing regenerates at build
 * time (see `vite.config.ts` for why the router's Vite plugin is deliberately not used). A route
 * file added, renamed or deleted without re-running `moon run app:route-tree` therefore produces
 * an app whose routes on disk and routes in the bundle disagree — a 404 on a page that visibly
 * exists in the repo, with nothing failing anywhere.
 *
 * HOW. Generate into a sibling temp path inside `src/` (NOT a system temp dir: the generated file
 * carries relative imports to `./routes/**`, so output written anywhere else would differ purely
 * by path and the comparison would be meaningless), run the same biome pass the generator task
 * does, compare bytes, delete the temp file.
 *
 * Lives in `scripts/`, not `src/`: it is a build tool that reads the filesystem and spawns a
 * process — server-side Bun, not part of the browser bundle. `biome.jsonc` lists this directory
 * beside the repo's other tooling for exactly that reason.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(SCRIPT_DIR, '..');
const COMMITTED_PATH = path.join(APP_ROOT, 'src', 'routeTree.gen.ts');
/** Inside `src/` (see the header) but outside `src/routes/`, so the generator never treats it as a
 * route file. The leading dot keeps it out of tsconfig's `include` glob results too. */
const TEMP_PATH = path.join(APP_ROOT, 'src', '.routeTree.check.gen.ts');
const CONFIG_PATH = path.join(APP_ROOT, 'tsr.config.json');

/**
 * Where a workspace binary actually lives depends on whether the install hoisted it. Bun hoists to
 * the workspace root, so `apps/app/node_modules/.bin` is usually absent entirely and a path
 * hardcoded to either location is a check that fails on somebody else's machine for a reason
 * unrelated to the routes. Resolved rather than assumed: local first, workspace root second.
 */
function binary(name: string): string {
  const local = path.join(APP_ROOT, 'node_modules', '.bin', name);
  return existsSync(local) ? local : path.join(APP_ROOT, '..', '..', 'node_modules', '.bin', name);
}

interface TsrConfig {
  readonly generatedRouteTree?: string;
}

function run(command: string, args: readonly string[]): { code: number; output: string } {
  const result = spawnSync(command, [...args], { cwd: APP_ROOT, encoding: 'utf8' });
  return {
    code: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  };
}

function main(): number {
  if (!existsSync(COMMITTED_PATH)) {
    process.stderr.write(
      'route-tree-check: src/routeTree.gen.ts is missing — run `moon run app:route-tree`\n',
    );
    return 1;
  }
  const committed = readFileSync(COMMITTED_PATH, 'utf8');

  // Point the generator at the temp output by rewriting the config for the duration of the run.
  // `tsr generate` reads `tsr.config.json` from the working directory and offers no output
  // override, so the config file is the only lever — restored in `finally`, unconditionally.
  const originalConfig = readFileSync(CONFIG_PATH, 'utf8');
  const parsedConfig = JSON.parse(originalConfig) as TsrConfig;

  try {
    writeFileSync(
      CONFIG_PATH,
      `${JSON.stringify({ ...parsedConfig, generatedRouteTree: './src/.routeTree.check.gen.ts' }, null, 2)}\n`,
      'utf8',
    );

    const generated = run(binary('tsr'), ['generate']);
    if (generated.code !== 0) {
      process.stderr.write(`route-tree-check: tsr generate failed\n${generated.output}\n`);
      return 1;
    }
    const formatted = run(binary('biome'), ['check', '--write', 'src/.routeTree.check.gen.ts']);
    if (formatted.code !== 0) {
      process.stderr.write(`route-tree-check: biome failed\n${formatted.output}\n`);
      return 1;
    }

    // The generator writes its own path into the file's own `declare module` block? It does not —
    // but it DOES emit nothing that depends on the output file name, which is what makes this a
    // byte comparison rather than a normalized one. If that ever changes, this check goes red on
    // an unchanged tree, which is the safe direction to fail.
    const regenerated = readFileSync(TEMP_PATH, 'utf8');
    if (regenerated === committed) {
      process.stdout.write('route-tree-check: src/routeTree.gen.ts is up to date\n');
      return 0;
    }

    process.stderr.write(
      'route-tree-check: src/routeTree.gen.ts is out of date — run `moon run app:route-tree`\n\n',
    );
    printLineDiff(committed, regenerated);
    return 1;
  } finally {
    writeFileSync(CONFIG_PATH, originalConfig, 'utf8');
    rmSync(TEMP_PATH, { force: true });
  }
}

/** No diff library (dependency-registry constraint) — a plain line-indexed comparison, exactly as
 * `apps/api/src/config/env-example.ts` does it. */
function printLineDiff(committed: string, regenerated: string): void {
  const committedLines = committed.split('\n');
  const regeneratedLines = regenerated.split('\n');
  const lineCount = Math.max(committedLines.length, regeneratedLines.length);

  for (let index = 0; index < lineCount; index += 1) {
    const before = committedLines[index];
    const after = regeneratedLines[index];
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

process.exit(main());
