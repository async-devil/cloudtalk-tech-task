import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The SAME React transform the app builds with: these suites render real components and drive a
  // real router, so a divergent transform would mean testing something the browser never runs.
  plugins: [react()],
  test: {
    // A browser bundle, so a DOM environment rather than the repo's usual `node` one.
    //
    // `happy-dom` rather than `jsdom`, for a portability reason worth recording (`packages/styles`'
    // config carries the same note). jsdom 30 bundles an undici that calls
    // `webidl.util.markAsUncloneable`, a helper that only exists in Node 22+. On a Node 20 host the
    // environment dies during setup with `markAsUncloneable is not a function`, and vitest reports
    // "no tests" while exiting non-zero — a failure that looks like a broken suite and is actually
    // a broken host requirement. Nothing in this repository pins a Node version, so the DOM
    // environment has to be the one that does not smuggle in a floor nobody declared.
    environment: 'happy-dom',
    include: ['test/**/*.test.{ts,tsx}'],
  },
});
