/**
 * Minimal hand-written ambient declarations for the Node/Bun surface these gate scripts use.
 *
 * Not `@types/node` or `bun-types`: `tsconfig.base.json` sets no `lib` or `types` beyond `ES2022`,
 * and this repository's tool packages declare their own scoped ambients rather than pull a full
 * types package in for a handful of signatures — the same declare-only-what-you-use pattern
 * `tools/extract-module` follows. Scoped to exactly what `tools/arch-checks/src/**` imports today;
 * widen it when a script starts using more of the surface, and only that much.
 */

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
  warn(...args: unknown[]): void;
};

interface ImportMeta {
  readonly url: string;
  readonly dirname: string;
  readonly main: boolean;
}

declare const URL: {
  new (url: string, base?: string): { readonly pathname: string; readonly href: string };
};

/** Only `byteLength`: PostgreSQL truncates identifiers past 63 BYTES, not characters, so the
 * length check has to measure the encoded form. */
declare const Buffer: {
  byteLength(input: string, encoding: 'utf8'): number;
};

declare const process: {
  exit(code?: number): never;
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: () => string;
};

declare module 'node:process' {
  export default process;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string, encoding?: 'utf8'): void;
  /** `typecheck-tests.ts` removes the throwaway tsconfig it writes into each package, in a
   * `finally` — the one place these scripts delete anything they created. */
  export function unlinkSync(path: string): void;
  export interface Dirent {
    readonly name: string;
    isDirectory(): boolean;
    isFile(): boolean;
  }
  // Both shapes are in use: the plain listing for a name-only walk, and the `withFileTypes`
  // variant where a scanner needs to tell a file from a directory without a second stat call.
  export function readdirSync(path: string): string[];
  export function readdirSync(path: string, options: { withFileTypes: true }): Dirent[];
  export interface Stats {
    isDirectory(): boolean;
    isFile(): boolean;
  }
  export function statSync(path: string): Stats;
}

declare module 'node:path' {
  function join(...segments: string[]): string;
  function resolve(...segments: string[]): string;
  function dirname(p: string): string;
  function basename(p: string, suffix?: string): string;
  function relative(from: string, to: string): string;
  function extname(p: string): string;
  const path: {
    join: typeof join;
    resolve: typeof resolve;
    dirname: typeof dirname;
    basename: typeof basename;
    relative: typeof relative;
    extname: typeof extname;
    readonly sep: string;
  };
  export default path;
  export { basename, dirname, extname, join, relative, resolve };
}

declare module 'node:url' {
  export function fileURLToPath(url: string): string;
}

declare module 'node:module' {
  export function createRequire(filename: string): (id: string) => unknown;
}

declare module 'node:child_process' {
  export interface SpawnSyncResult {
    readonly status: number | null;
    readonly error?: Error;
    readonly stdout?: string;
    readonly stderr?: string;
  }
  export function spawnSync(
    command: string,
    args: readonly string[],
    options?: {
      readonly cwd?: string;
      readonly stdio?: 'inherit' | 'ignore';
      readonly encoding?: 'utf8';
    },
  ): SpawnSyncResult;
}
