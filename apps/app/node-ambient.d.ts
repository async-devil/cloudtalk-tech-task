/**
 * Minimal hand-written ambient declarations for the Node-only surface this app's SERVER-SIDE
 * TOOLING uses — no `@types/node`, no `bun-types`, no registry entry, following the ruled pattern
 * in `apps/api/src/ambient.d.ts` / `packages/config/src/ambient.d.ts` (ADR-0003).
 *
 * Hand-written ambients are the decision, not an oversight: a `@types/node` entry would license
 * the entire Node surface across this project, and this project is a BROWSER BUNDLE. The only
 * server-side code here is `scripts/` (the route-tree freshness gate) and `e2e/` (the Playwright
 * config and its `webServer` harness) — together they use exactly what is declared below, and
 * nothing under `src/` may import any of it (`biome.jsonc` keeps `noNodejsModules` on `src/`).
 *
 * Lives at the project root rather than inside either directory because both trees share it:
 * ambient module declarations MERGE across files, so a second `declare module 'node:child_process'`
 * beside this one would collide on every member the two happened to name in common. One file,
 * listed explicitly in `tsconfig.json`'s `include`.
 */

declare module 'node:child_process' {
  /** The subset of `SpawnSyncReturns` the callers read. `error` is set only when the spawn itself
   * failed (binary missing, permission denied) — distinct from a non-zero `status`. */
  export function spawnSync(
    command: string,
    args: readonly string[],
    options: {
      cwd?: string;
      encoding?: 'utf8';
      stdio?: 'inherit' | 'pipe';
      env?: Record<string, string>;
    },
  ): {
    status: number | null;
    stdout: string | null;
    stderr: string | null;
    error?: Error | undefined;
  };

  /** Only the members `e2e/harness/start-api-server.ts` uses on the long-lived api child: signal
   * forwarding when Playwright tears the `webServer` down, and the exit code it waits on. */
  export interface ChildProcessWithoutNullStreams {
    kill(signal: 'SIGTERM' | 'SIGINT'): boolean;
    on(event: 'exit', listener: (code: number | null) => void): void;
  }

  export function spawn(
    command: string,
    args: readonly string[],
    options: { cwd?: string; stdio?: 'inherit' | 'pipe'; env?: Record<string, string> },
  ): ChildProcessWithoutNullStreams;
}

declare module 'node:fs' {
  export function existsSync(path: string): boolean;
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string, encoding: 'utf8'): void;
  export function rmSync(path: string, options: { force: boolean }): void;
}

declare module 'node:path' {
  const path: {
    dirname(input: string): string;
    join(...segments: string[]): string;
    resolve(...segments: string[]): string;
  };
  export default path;
}

declare module 'node:process' {
  const process: {
    /** Read by `e2e/` for the `CI` flag and the `E2E_DATABASE_URL`/`E2E_REDIS_URL` overrides, and
     * to forward `PATH` into every spawned child. Never read from `src/` — the SPA's one config
     * key arrives through Vite's `import.meta.env`. */
    readonly env: Record<string, string | undefined>;
    readonly stdout: { write(chunk: string): void };
    readonly stderr: { write(chunk: string): void };
    exit(code?: number): never;
    on(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  };
  export default process;
}

declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string;
}
