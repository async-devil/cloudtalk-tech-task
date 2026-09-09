import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // A DOM environment, not the repo's usual `node` one: these are DOM components, and the
    // primitive tests render them through @testing-library/react.
    //
    // `happy-dom` rather than `jsdom`, for a portability reason worth recording. jsdom 30 bundles
    // an undici that calls `webidl.util.markAsUncloneable`, a helper that only exists in Node 22+.
    // On a Node 20 host the environment dies during setup with `markAsUncloneable is not a
    // function`, and vitest reports "no tests" while exiting non-zero — a failure that looks like
    // a broken suite and is actually a broken host requirement. Nothing in this repository pins a
    // Node version (ADR-0002 pins Bun, which vitest does not run on), so the DOM environment has
    // to be the one that does not smuggle in a floor nobody declared.
    environment: 'happy-dom',
    // REQUIRED, not cosmetic: with the default `css: false`, vitest stubs every CSS module — and
    // it stubs the token CSS's `?raw` imports too, handing the token tests an EMPTY STRING instead of the
    // stylesheet. Every assertion in `test/design-tokens.test.ts` would then pass vacuously
    // ("no token is below 11px" is trivially true of no tokens). Verified empirically at:
    // without this flag the raw import is `''` and with it the real 5KB source arrives.
    css: true,
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
