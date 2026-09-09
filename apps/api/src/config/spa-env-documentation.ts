import type { EnvDocumentationSection } from '@repo/config';

/**
 * `apps/app`'s env surface, documented in the shared `.env.example`.
 *
 * WHY IT LIVES HERE, in the backend app, and not with the SPA. `.env.example` is a REPO-level
 * artifact with exactly one writer — `env-example.ts`, whose check mode (`api:env-example-check`)
 * fails on any hand edit. That writer needs `apps/api`'s composed config slices, so it cannot
 * move; and it cannot import from `apps/app` either, because apps are leaves and never depend on
 * each other (ADR-0001). So the SPA's section is declared beside the generator.
 *
 * WHAT KEEPS IT HONEST. A copy of a default in a second place is a default that will drift. A
 * test over `apps/app`'s committed `.env.example` should assert it documents this key with the
 * same default `apps/app/src/shared/api` actually falls back to — so the two ends are reconciled
 * even though no import connects them.
 *
 * NOT a `ConfigSlice`: Vite inlines `VITE_*` at build time and no server process ever reads this
 * variable, so parsing it at boot would be fiction — and, in a fail-closed tier, fiction that
 * could refuse to start.
 */
export const SPA_ENV_DOCUMENTATION: EnvDocumentationSection = {
  key: 'apps/app',
  entries: [
    {
      name: 'VITE_API_URL',
      description:
        "The SPA's entire config surface. Origin of this api as the BROWSER reaches it; the SPA\n" +
        'appends the /api mount prefix itself. Read via import.meta.env — the documented\n' +
        'exception to "no env outside @repo/config" — and inlined at build time, so changing it\n' +
        'needs a rebuild, not a restart. Everything else the client needs arrives in the\n' +
        'bootstrap payload.',
      defaultValue: 'http://localhost:3000',
    },
  ],
};
