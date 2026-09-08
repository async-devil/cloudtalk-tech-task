/**
 * Minimal hand-written ambient declaration for the `node:fs/promises` surface this package's
 * `envFileSource` uses to read `.env` files. No `@types/node` dependency (no registry entry);
 * this mirrors the declare-only-what-you-use pattern used across the repository's other
 * hand-written ambients.
 *
 * Why `node:fs/promises` and not Bun's native `Bun.file`/`import { file } from 'bun'` (tried
 * first, both reverted): Vitest loads source files through its own module runner
 * (`vite-node`)/worker sandbox, which does not inject Bun's `globalThis.Bun` and does not
 * special-case the `bun` bare specifier the way Bun's own loader does — `Bun.file(...)` threw
 * `ReferenceError: Bun is not defined` inside `test/sources.test.ts` even though the suite runs
 * under the Bun runtime (empirically verified). `node:fs/promises` works identically under Bun
 * and inside Vitest's sandbox, so it is the only reliable, testable choice here.
 *
 * node:* usage in backend packages is sanctioned in `biome.jsonc` (the `noNodejsModules` override
 * lists the backend package set explicitly).
 */
declare module 'node:fs/promises' {
  export function readFile(path: string, encoding: 'utf8'): Promise<string>;
}
