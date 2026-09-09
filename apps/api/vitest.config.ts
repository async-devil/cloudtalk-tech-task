import { defineConfig } from 'vitest/config';

/**
 * This suite runs on Bun, not on Node, and that is a hard requirement rather than a preference:
 * Elysia calls `Promise.withResolvers`, which exists only in Node 22+, so on an older Node every
 * test that constructs the app dies inside the framework with `Promise.withResolvers is not a
 * function`. Nothing in this repository pins a Node version (ADR-0002 pins Bun), so the suite
 * targets the runtime the application actually ships on. Run it with `bun x --bun vitest run`;
 * the `api:test` task in `moon.yml` does exactly that.
 *
 * `resolve.conditions` is the price of running under Bun. Bun advertises a `bun` export condition,
 * and zod 4's `exports` map answers a bare condition list with `@zod/source` — its raw TypeScript
 * entry — which vitest's transform then hands back without the named exports initialized, so
 * `import { z } from 'zod'` yields `undefined` and every schema fails at module evaluation with
 * `z.object is not an object`. Naming the conditions explicitly pins resolution to the published
 * ESM build. Measured, not guessed: plain `bun -e "import {z} from 'zod'"` resolves correctly, so
 * the defect is in the resolution vitest performs, not in Bun or in zod.
 */
export default defineConfig({
  resolve: {
    conditions: ['import', 'default'],
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    server: {
      // zod is inlined rather than externalized. Left external, vitest hands the import to Bun's
      // own module loader, and the ESM/CJS interop it gets back has no initialized named exports —
      // `import { z } from 'zod'` is `undefined` by the time a schema is constructed. Inlining
      // puts the resolution through vite, which honours the conditions pinned above.
      deps: { inline: [/zod/] },
    },
  },
});
