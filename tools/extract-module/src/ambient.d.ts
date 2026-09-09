/**
 * Minimal hand-written ambient declarations for the Node/Bun surface this package's scripts use.
 * Not `@types/node`/`bun-types`: `tsconfig.base.json` sets no `lib`/`types` beyond `ES2022`, and
 * this repository's tool packages declare their own scoped ambients rather than pull in a full
 * types package for a handful of signatures — the same declare-only-what-you-use pattern used
 * across the repository's other hand-written ambients. Scoped exactly to what
 * `tools/extract-module` currently imports; widen it if a script starts using more of the surface.
 */

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

interface ImportMeta {
  readonly url: string;
  readonly main: boolean;
}

declare module 'node:process' {
  const process: {
    exit(code?: number): never;
    readonly argv: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
  };
  export default process;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  // workspace.ts: plain filename listing (no Dirent — `statSync` on each name decides file vs
  // directory), unlike arch-checks' `{ withFileTypes: true }` variant.
  export function readdirSync(path: string): string[];
  export interface Stats {
    isDirectory(): boolean;
  }
  export function statSync(path: string): Stats;
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function writeFileSync(path: string, data: string, encoding: 'utf8'): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
  // extract.ts: one fresh temp directory per extraction run, outside the repo (the whole point
  // of the extraction proof).
  export function mkdtempSync(prefix: string): string;
}

declare module 'node:os' {
  export function tmpdir(): string;
}

declare module 'node:path' {
  function join(...segments: string[]): string;
  function resolve(...segments: string[]): string;
  function dirname(p: string): string;
  function relative(from: string, to: string): string;
  const path: {
    join: typeof join;
    resolve: typeof resolve;
    dirname: typeof dirname;
    relative: typeof relative;
  };
  export default path;
  export { dirname, join, relative, resolve };
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

declare module 'node:child_process' {
  export interface SpawnSyncResult {
    readonly status: number | null;
    readonly signal?: string | null;
    readonly error?: Error;
    readonly stdout: string;
    readonly stderr: string;
  }
  export function spawnSync(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly stdio?: 'inherit';
      readonly encoding?: 'utf8';
    },
  ): SpawnSyncResult;
  export function execFileSync(
    command: string,
    args: readonly string[],
    options: {
      readonly cwd?: string;
      readonly encoding?: 'utf8';
    },
  ): string;
}
