import { APP_MODE, type AppMode } from '@repo/config';
import { Elysia } from 'elysia';

/** Elysia has no exported `Plugin` type of its own — a plugin IS an `Elysia` instance consumed
 * via `.use()`. Aliased under a name that reads as the literal signature it is. */
export type ElysiaPlugin = Elysia;

const PERMISSIONS_POLICY = 'camera=(), geolocation=(), microphone=(), payment=()';

/** The frozen header set (ADR-0013), as a pure record — the single source both
 * {@link securityHeaders} (the Elysia plugin) and {@link applySecurityHeaders} (the manual
 * wrapper `runtime/build-app.ts` actually calls on every response, see that file's header note
 * on why) build from, so the two can never drift on what "every response" carries. */
export function buildSecurityHeaders(mode: AppMode): Record<string, string> {
  const headers: Record<string, string> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "frame-ancestors 'none'",
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': PERMISSIONS_POLICY,
    // Every API response, including the health one-liners — session-scoped JSON must never land
    // in a shared or disk cache.
    'Cache-Control': 'no-store',
  };
  // HSTS only in fail-closed tiers (staging/production) — it breaks plain-http localhost dev.
  if (mode !== APP_MODE.Test) {
    headers['Strict-Transport-Security'] = 'max-age=31536000; includeSubDomains';
  }
  return headers;
}

/** Adds the frozen header set to any `Response`, without disturbing its body/status — the
 * function `runtime/build-app.ts` actually calls at every response-producing site (the
 * instrumented handler, the auth mount, and the top-level `onError`), because this app's
 * mount-based routing means Elysia's own `onRequest`/`onAfterResponse` lifecycle hooks do NOT
 * fire for the mounted routes that carry essentially all real traffic here (see
 * `build-app.ts`'s RED-histogram header note for the identical problem/solution shape). */
export function applySecurityHeaders(response: Response, mode: AppMode): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(buildSecurityHeaders(mode))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * `securityHeaders`: a real Elysia plugin, usable via `.use()` for any genuinely Elysia-routed
 * response (Elysia's own top-level "no route matched" and any request Elysia rejects before a
 * route runs). It is NOT, by itself, sufficient for this app's shape — see
 * {@link applySecurityHeaders}'s header note — so `build-app.ts` applies both: this plugin for
 * defense-in-depth on the Elysia-native paths, and the manual wrapper everywhere the response is
 * actually produced. A judgment call, not a silent divergence: "one Elysia hook, applied to every
 * response" is unimplementable as a hook ALONE in a mount-based app.
 */
export function securityHeaders(options: { readonly mode: AppMode }): ElysiaPlugin {
  const headers = buildSecurityHeaders(options.mode);
  return new Elysia({ name: 'security-headers' }).onAfterHandle(({ set }) => {
    Object.assign(set.headers, headers);
  });
}
