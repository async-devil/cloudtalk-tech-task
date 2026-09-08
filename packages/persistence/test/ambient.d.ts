/**
 * Minimal ambient declarations for the WHATWG `URL` global and `import.meta.url` used by the
 * tests to resolve fixture-folder paths. Mirrors `packages/config/test/ambient.d.ts` — test/ is
 * intentionally outside the package's own `tsconfig.json` `include` (package template), but kept
 * clean for anyone who runs `tsc` with `test/` included.
 */
interface ImportMeta {
  readonly url: string;
}

declare class URL {
  constructor(input: string, base?: string);
  readonly pathname: string;
}
