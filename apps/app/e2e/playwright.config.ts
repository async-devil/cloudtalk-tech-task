import process from 'node:process';
import { defineConfig } from '@playwright/test';
import { API_PORT, APP_BASE_URL, APP_PREVIEW_PORT } from './constants.js';

/**
 * Desktop + mobile Chromium projects, a `webServer` pair (the api in `APP_MODE=test` against the
 * dev compose stack, and `vite preview` serving the built SPA), and session-mock support
 * (`fixtures.ts` / `harness/session-mock.ts`).
 *
 * Run from `apps/app` (`bun run e2e`, `moon run app:e2e`): `testDir` and both `webServer.cwd`
 * values are resolved relative to THIS file, i.e. `apps/app/`.
 */
export default defineConfig({
  testDir: './specs',
  // Spelled explicitly rather than left to Playwright's default, which resolves relative to THIS
  // file's directory (`apps/app/e2e/`) while `.gitignore` and the `e2e` CI job's trace-upload step
  // both name `apps/app/test-results/`. Three places agreeing by construction beats three places
  // agreeing by coincidence — and the failure mode of the mismatch is silent: untracked artifacts
  // in git status, and an artifact upload that finds nothing on the one run anybody needed it.
  outputDir: '../test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: APP_BASE_URL,
    trace: 'retain-on-failure',
  },

  // Frozen: desktop-chromium (1280×800) and mobile-chromium (390×844, touch, device-scale 2) —
  // both run in CI. Hand-specified viewport/touch/scale rather than a named `devices[...]` preset,
  // so the frozen numbers stay exactly what is pinned regardless of what a future Playwright
  // release ships as "iPhone whatever"'s defaults.
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 1280, height: 800 },
      },
    },
    {
      name: 'mobile-chromium',
      use: {
        browserName: 'chromium',
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
        deviceScaleFactor: 2,
      },
    },
  ],

  // Both entries are started for every test run regardless of which project/spec is selected —
  // Playwright's `webServer` is not per-project. `reuseExistingServer` (true outside CI) is what
  // lets a developer (or a verification run) pre-start either half by hand and have Playwright
  // skip straight to polling readiness instead of re-running the command.
  webServer: [
    {
      // `cwd` defaults to this config file's own directory (`apps/app/e2e/`) per Playwright's
      // documented default, which is exactly where `harness/start-api-server.ts` lives.
      command: 'bun run harness/start-api-server.ts',
      port: API_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // `vite build` then `vite preview` — the built app, not the dev server (5173 is deliberately
      // not this stack's origin; see `harness/start-api-server.ts`'s `HTTP_CORS_ALLOWED_ORIGINS`
      // comment). `cwd: '..'` is `apps/app/` (relative to this config file), where the app's own
      // `build`/`preview` scripts live.
      command: 'bun run build && bun run preview',
      cwd: '..',
      port: APP_PREVIEW_PORT,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
