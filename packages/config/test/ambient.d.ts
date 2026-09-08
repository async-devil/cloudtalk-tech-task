/**
 * Minimal ambient declarations for the WHATWG `URL` global and `import.meta.url` used by
 * `sources.test.ts` to resolve fixture paths. Not part of the package's own `tsconfig.json`
 * `include` (test/ is intentionally outside it, per the package template), but kept clean for
 * anyone who runs `tsc` with `test/` included.
 */
interface ImportMeta {
  readonly url: string;
}

declare class URL {
  constructor(input: string, base?: string);
  readonly pathname: string;
}
