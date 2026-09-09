/**
 * Minimal hand-written ambient declarations for the Node-only surface this app's scripts use
 * (`node:process`, `node:url`'s `fileURLToPath`) — no `@types/node`/`bun-types`, following the
 * pattern in `packages/config/src/ambient.d.ts`. `URL`, `performance`, `Request`, `Response`,
 * `Headers` etc. come from `tsconfig.json`'s `"lib": ["ES2022", "DOM"]` (added for the Fetch API
 * surface elysia's `.mount()` and oRPC's fetch adapter need) — declaring them by hand here too
 * would just duplicate what `lib.dom.d.ts` already provides.
 *
 * Hand-written ambients are a ruled decision, not an oversight (ADR-0003): the dependency
 * registry admits no dependency without an entry, and a `@types/node`/`bun-types` entry would
 * license the entire Node/Bun surface everywhere — runtime-API sprawl the "modules survive
 * extraction" law (ADR-0001) exists to catch. These declarations are minimal, per-package, and
 * list only the surface actually used.
 */

declare module 'node:process' {
  // Imported (not used as a global): Biome's noNodejsModules exemption for apps/api plus its
  // organize-imports/style pass prefer the explicit `node:process` module form.
  const process: {
    readonly env: Record<string, string | undefined>;
    // env-example.ts's `--write` flag check.
    readonly argv: readonly string[];
    readonly stdout: { write(chunk: string): void };
    readonly stderr: { write(chunk: string): void };
    exit(code?: number): never;
    // main.ts's SIGTERM/SIGINT graceful-close hooks.
    on(event: 'SIGTERM' | 'SIGINT', listener: () => void): void;
  };
  export default process;
}

declare module 'node:url' {
  export function fileURLToPath(url: URL | string): string;
}

declare module 'node:fs/promises' {
  // env-example.ts's read (drift check) / write (`--write`) of the committed `.env.example` —
  // same minimal declare-only-what-you-use pattern as packages/config/src/ambient.d.ts's own
  // node:fs/promises block.
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
  export function writeFile(path: string, data: string, encoding: 'utf8'): Promise<void>;
}
