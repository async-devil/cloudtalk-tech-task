import { opentelemetry } from '@elysiajs/opentelemetry';
import { APP_MODE, type AppMode } from '@repo/config';
import { ERROR_CODE } from '@repo/kernel';
import {
  createModuleObservability,
  type InstrumentSpecification,
  METRIC_ATTRIBUTE,
} from '@repo/observability';
import { Elysia } from 'elysia';
import { classifyError, errorResponseFor } from '../http/error-mapper.js';
import { createHttpHandler, type HttpHandlerDeps } from '../http/index.js';
import { routeTemplateOf } from '../http/route-template.js';
import { type BodyCapOptions, enforceBodyCap } from '../http/security/body-cap.js';
import { applyCorsHeaders, type CorsOptions, preflightResponseFor } from '../http/security/cors.js';
import { applySecurityHeaders, buildSecurityHeaders } from '../http/security/headers.js';
import { withRetryAfterHeader } from '../http/security/rate-limit.js';
import { type HealthRoutesDependencies, mountHealthRoutes } from './health-routes.js';
import { mountTestSessionRoute, type TestSessionMockDependencies } from './test-session-route.js';

/** The auth wiring `buildApp` mounts, optional so a suite with no interest in auth keeps
 * constructing the app unchanged.
 *
 * Mounts only the better-auth fetch handler (a plain function — the magic-link sign-in flow an
 * e2e drives). The session middleware (`@repo/auth`'s `createSessionMiddleware` /
 * `resolveRequestSession`) is exported and container-tested, but its ROUTE-LEVEL wiring is
 * `BuildAppDeps.session` (below), not an Elysia plugin: the contract routes are a mounted WinterCG
 * handler, and Elysia's `.derive` does not fire for mounted routes (see the header note on why
 * the RED histogram records inside the handler), so `http/index.ts` resolves the session into the
 * oRPC context via `resolveRequestSession` directly — there is nothing for an Elysia session
 * plugin to enrich here. */
export interface AuthWiring {
  /** The better-auth fetch handler (`@repo/auth`'s `createAuth(...).handler`). */
  readonly handler: (request: Request) => Promise<Response>;
}

export interface BuildAppDeps extends HttpHandlerDeps {
  readonly auth?: AuthWiring;
  /** `test`-tier default when absent (HSTS off) — the same optionality precedent
   * `auth`/`session`/`rateLimiters` already set, so suites with no interest in the security
   * baseline (`build-app.test.ts`, `boot-fail-closed.test.ts`) keep constructing the app
   * unchanged. The real composition root (`runtime/main.ts`) always supplies it. */
  readonly mode?: AppMode;
  /** Credentialed CORS from an explicit allow-list. Optional — absent means no CORS headers are
   * ever added (same-origin-only), never a wildcard fallback. */
  readonly cors?: CorsOptions;
  /** The JSON body cap. Optional — absent means no cap is enforced. */
  readonly bodyCap?: BodyCapOptions;
  /**
   * The e2e session-mock route's wiring. Optional AND mode-gated — the route is registered only
   * when `mode === 'test'` AND this is present, so a fail-closed deployment that somehow received
   * these deps still never gets the route (see `test-session-route.ts`'s header;
   * `test/test-session-route.test.ts` proves the production build has no such path).
   */
  readonly sessionMock?: TestSessionMockDependencies;
  /**
   * `GET /health`/`GET /health/worker`. Optional, same precedent as `sessionMock` — suites with
   * no interest in health checks (most of this file's own test suite) keep constructing the app
   * unchanged; the real composition root (`runtime/main.ts`) always supplies it. Absence does NOT
   * change what the routes return on a 404 basis — the routes are simply never registered, so
   * `/health`/`/health/worker` fall through to whatever Elysia does with an unmatched top-level
   * path.
   */
  readonly health?: HealthRoutesDependencies;
}

const obs = createModuleObservability('api');

/** RED histogram: the exemplar carrier a trace-correlation check inspects. Bodies are never
 * logged; only the route TEMPLATE + method + status class travel as attributes — the template,
 * never the concrete path, or per-entity ids would explode the series cardinality (ADR-0009). The
 * template comes from the routing layer's contract-derived resolver, not a hardcoded regex
 * (ADR-0004). Exported (not through a package barrel — apps are leaves, ADR-0001) so
 * `test/error-mapper.test.ts` can pin its `allowedAttributes` identical to `api.http.error`'s
 * (the ADR-0009 counter-dimension identity) without re-declaring the list. */
export const API_HTTP_REQUEST_INSTRUMENT: InstrumentSpecification & { unit: string } = {
  name: 'api.http.request',
  unit: 'ms',
  allowedAttributes: [
    METRIC_ATTRIBUTE.Route,
    METRIC_ATTRIBUTE.Method,
    METRIC_ATTRIBUTE.StatusClass,
  ],
};
const httpRequestHistogram = obs.createHistogram(API_HTTP_REQUEST_INSTRUMENT);

/** `api.http.body-rejected`: one tick per 413. */
export const API_HTTP_BODY_REJECTED_INSTRUMENT: InstrumentSpecification = {
  name: 'api.http.body-rejected',
  allowedAttributes: [METRIC_ATTRIBUTE.Route],
};
const bodyRejectedCounter = obs.createCounter(API_HTTP_BODY_REJECTED_INSTRUMENT);

function statusClassOf(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/**
 * Builds the Elysia app: `@elysiajs/opentelemetry` provides the server spans (it detects
 * `initObservability` already registered a tracer provider and does not start a second SDK —
 * ADR-0009's "exactly once" holds); the oRPC adapter mounts under `/api`. Exported (not started)
 * so tests can drive routes without a socket.
 *
 * The RED histogram records INSIDE the mounted handler, not via an Elysia lifecycle hook:
 * `mount()` delegates to a WinterCG fetch handler and Elysia's `onAfterResponse`/`onRequest`
 * hooks do NOT fire for mounted routes — verified: the original hook-based wiring exported ZERO
 * metrics because every real route lives under `/api`. Measuring inside the handler also keeps
 * the `record()` within the still-active server span, so a trace exemplar attaches to the
 * datapoint the moment the SDK can emit one.
 */
export function buildApp(deps: BuildAppDeps): Elysia {
  const mode = deps.mode ?? APP_MODE.Test;
  const httpHandler = createHttpHandler(deps);

  const instrumentedHandler = async (request: Request): Promise<Response> => {
    const startedAt = performance.now();
    const response = await httpHandler(request);

    httpRequestHistogram.record(performance.now() - startedAt, {
      route: routeTemplateOf(new URL(request.url).pathname),
      method: request.method,
      status_class: statusClassOf(response.status),
    });

    return response;
  };

  // The security baseline's response finishing touches, shared by every mounted route — see
  // `http/security/headers.ts`'s header note for why this app applies them as a manual wrapper
  // rather than relying on Elysia's `onAfterResponse`/`onRequest` (verified above: those hooks do
  // not fire for mounted routes, which is essentially every real request here). `enforceBodyCap`
  // runs BEFORE the inner handler ever sees the request (a cap applies to any JSON body, auth's
  // sign-in included); CORS/security headers run AFTER, on the way out, for both the success and
  // the error path.
  const withHttpSecurity =
    (
      routeTemplateFor: (request: Request) => string,
      inner: (request: Request) => Promise<Response>,
    ) =>
    async (request: Request): Promise<Response> => {
      const origin = request.headers.get('origin');
      if (request.method === 'OPTIONS') {
        const preflight =
          deps.cors !== undefined
            ? preflightResponseFor(origin, deps.cors)
            : new Response(null, { status: 204 });
        return applySecurityHeaders(preflight, mode);
      }

      let workingRequest = request;
      if (deps.bodyCap !== undefined) {
        try {
          workingRequest = await enforceBodyCap(request, deps.bodyCap);
        } catch (error) {
          const routeTemplate = routeTemplateFor(request);
          bodyRejectedCounter.add(1, { route: routeTemplate });
          const capResponse = errorResponseFor(error, {
            routeTemplate,
            method: request.method,
          });
          const withCors =
            deps.cors !== undefined
              ? applyCorsHeaders(capResponse, origin, deps.cors)
              : capResponse;
          return applySecurityHeaders(withCors, mode);
        }
      }

      const response = await inner(workingRequest);
      const withCors =
        deps.cors !== undefined ? applyCorsHeaders(response, origin, deps.cors) : response;
      return applySecurityHeaders(withCors, mode);
    };

  // Elysia-level errors OUTSIDE the mount: malformed requests the framework itself rejects before
  // ever reaching `instrumentedHandler`/the oRPC adapter (e.g. its own body parsing), PLUS
  // Elysia's own top-level "no route matched" (any path outside `/api` — the mount swallows
  // everything under it, so this only fires for genuinely unregistered paths). Elysia's own
  // `NotFoundError` isn't a kernel `AppError`, so routing it through `classifyError` would
  // misclassify it as a generic 500 (`isAppError` is false for it) — `code === 'NOT_FOUND'` is
  // special-cased to the SAME uniform wire shape the oRPC unmatched-route branch returns
  // (http/index.ts), consistent with that branch's deliberate no-`failSpan` asymmetry: nothing
  // was "handled", so the error signal stays clean. Every other Elysia-level error (validation/
  // parse/internal) maps through the same `classifyError` to the same wire shape — this is
  // deliberately not a `failSpan` call site: `mount()`'s WinterCG delegation means no server span
  // is guaranteed active yet at this hook (see the header note on why metrics are recorded inside
  // the handler, not via lifecycle hooks), and the boundary this error actually crossed is
  // Elysia's own request parsing, not a route this app owns telemetry for.
  const app = new Elysia().use(opentelemetry());

  // Mount better-auth's handler under `/api/auth/*` BEFORE the oRPC mount. Elysia gives the
  // explicit `/api/auth/*` route precedence over the `/api` mount and forwards it the FULL path
  // (better-auth's `basePath` is `/api/auth`), while the mount forwards `/api/*` with the prefix
  // stripped to the oRPC handler (verified: the route wins, the mount handles the rest).
  if (deps.auth !== undefined) {
    const { auth } = deps;
    const authRoute = withHttpSecurity(
      () => 'auth',
      async (req: Request) => {
        // Bucket 1 (Auth), keyed by client IP — checked BEFORE delegating to better-auth's
        // handler, satisfying "before better-auth's mount" trivially (this IS the first thing
        // this route does).
        if (deps.rateLimiters !== undefined) {
          try {
            await deps.rateLimiters.checkAuth(req);
          } catch (error) {
            return withRetryAfterHeader(
              errorResponseFor(error, { routeTemplate: 'auth', method: req.method }),
              error,
            );
          }
        }
        return auth.handler(req);
      },
    );
    app.all('/api/auth/*', ({ request }: { request: Request }) => authRoute(request));
  }

  // The e2e session-mock route, in `test` mode ONLY. The `mode` check is the structure — in a
  // fail-closed tier this block does not run, so nothing registers the path and the request falls
  // through to the oRPC mount's unmatched-route 404. `mountTestSessionRoute` additionally refuses
  // a non-test mode, so the door has two locks (see its header).
  if (mode === APP_MODE.Test && deps.sessionMock !== undefined) {
    mountTestSessionRoute(app, mode, deps.sessionMock);
  }

  // `GET /health`/`GET /health/worker`, origin-root, registered BEFORE the `/api` mount for the
  // identical reason the session-mock route above is — see `health-routes.ts`'s header for why
  // that also keeps them out of the RED histogram.
  if (deps.health !== undefined) {
    mountHealthRoutes(app, deps.health, mode);
  }

  app.onError(({ code, error, set }) => {
    // Security headers on EVERY response class, including a genuinely Elysia-routed 404/error —
    // this IS a real (non-mount) Elysia lifecycle hook, so `set.headers` reaches the response
    // Elysia builds from this callback's return value.
    Object.assign(set.headers, buildSecurityHeaders(mode));
    if (code === 'NOT_FOUND') {
      set.status = 404;
      return { code: ERROR_CODE.NotFound, message: 'Not Found' };
    }
    const classified = classifyError(error);
    set.status = classified.httpStatus;
    return classified.wire;
  });
  return app.mount(
    '/api',
    withHttpSecurity(
      (request) => routeTemplateOf(new URL(request.url).pathname),
      instrumentedHandler,
    ),
  );
}
