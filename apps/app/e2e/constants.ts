/**
 * Ports and origins the e2e stack agrees on. `playwright.config.ts`'s `webServer` entries,
 * `harness/start-api-server.ts`, `harness/session-mock.ts` and every spec import these — one
 * source, so the api's CORS allow-list, the app's `VITE_API_URL`, and the browser's `baseURL` can
 * never drift apart from each other.
 */

/** `vite preview`'s port (`apps/app/vite.config.ts`'s `preview.port`) — the built SPA the e2e
 * projects drive. Not the `vite` DEV port (5173). */
export const APP_PREVIEW_PORT = 4173;

/** The api's e2e listen port — matches `apps/api/src/config/api-slice.ts`'s own default. */
export const API_PORT = 3000;

export const APP_BASE_URL = `http://localhost:${APP_PREVIEW_PORT}`;
export const API_BASE_URL = `http://localhost:${API_PORT}`;

/**
 * Where the CONTRACT routes actually live. `apps/api` serves them behind `Elysia#mount('/api',
 * …)`, so the origin alone 404s — a distinction that costs an afternoon every time someone
 * rediscovers it, which is why it is a named constant rather than a `/api` scattered through the
 * specs. `harness/session-mock.ts` keeps its own full path because the test-session route is not a
 * contract route.
 */
export const API_ROUTES_BASE_URL = `${API_BASE_URL}/api`;
