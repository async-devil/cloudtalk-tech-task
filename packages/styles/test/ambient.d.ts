/**
 * Vite's `?raw` import suffix, declared for the token tests only.
 *
 * `packages/styles` is a browser-bundle target, so biome's `noNodejsModules` holds here (see
 * `biome.jsonc`'s override list, which deliberately omits this package): the token tests cannot
 * `readFileSync` the token CSS. Vite's documented `?raw` suffix — which vitest inherits, because it
 * runs the same transform pipeline — hands the file over as a string with no `node:fs` anywhere.
 */
declare module '*.css?raw' {
  const contents: string;
  export default contents;
}
