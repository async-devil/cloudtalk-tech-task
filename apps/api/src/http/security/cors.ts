/**
 * Credentialed CORS only from `HTTP_CORS_ALLOWED_ORIGINS` (comma-separated exact origins). No
 * wildcard with credentials, ever: {@link corsHeadersFor} REFLECTS an allow-listed origin
 * verbatim (never `*`) and returns nothing for an unlisted one — wildcard-with-credentials is
 * structurally unconstructible from this function's shape, not merely unconfigured.
 */
export interface CorsOptions {
  readonly allowedOrigins: readonly string[];
}

const CORS_HEADERS_BASE = {
  'Access-Control-Allow-Credentials': 'true',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, authorization',
} as const;

/** Returns the CORS response headers for a request's `Origin`, or `undefined` when the origin is
 * absent or not on the allow-list (no CORS headers at all — never a reflected wildcard). */
export function corsHeadersFor(
  origin: string | null,
  options: CorsOptions,
): Record<string, string> | undefined {
  if (origin === null || !options.allowedOrigins.includes(origin)) {
    return undefined;
  }
  return { ...CORS_HEADERS_BASE, 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

/** Applies {@link corsHeadersFor} to a `Response` in place of a fresh object, preserving body/
 * status — used both for the real response and for a preflight `OPTIONS` short-circuit. */
export function applyCorsHeaders(
  response: Response,
  origin: string | null,
  options: CorsOptions,
): Response {
  const corsHeaders = corsHeadersFor(origin, options);
  if (corsHeaders === undefined) {
    return response;
  }
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/** A bare 204 for a CORS preflight `OPTIONS` request, carrying the allow-list's headers (or none,
 * for an unlisted origin — the browser's own same-origin policy then blocks the real request). */
export function preflightResponseFor(origin: string | null, options: CorsOptions): Response {
  const corsHeaders = corsHeadersFor(origin, options) ?? {};
  return new Response(null, { status: 204, headers: corsHeaders });
}
