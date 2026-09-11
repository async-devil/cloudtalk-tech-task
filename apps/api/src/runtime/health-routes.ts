import type { AppMode } from '@repo/config';
import { applySecurityHeaders } from '../http/security/headers.js';
import { isWorkerHalfHealthy, type WorkerHealth } from './worker-liveness.js';

/**
 * ============================================================================================
 * HEALTH ENDPOINTS — origin-root, unauthenticated, never RED-metered.
 * ============================================================================================
 *
 * `GET /health` answers "is this process serving AND can it reach Postgres" (a bounded `SELECT 1`
 * round trip, a 5s budget). `GET /health/worker` answers "are the in-process background workers
 * this composition root started actually attached, and are their repeatable schedules registered
 * in Redis" — a deploy's own health gate polls both before recreating app services, and rolls
 * back on either one staying red.
 *
 * WHY THESE LIVE HERE, NOT INSIDE THE `/api` MOUNT. Both are registered on the Elysia app
 * directly, BEFORE `app.mount('/api', ...)` — the same origin-root shape used elsewhere in
 * `runtime/build-app.ts`, for the same reason: the RED histogram (`build-app.ts`'s
 * `httpRequestHistogram`) records INSIDE the mounted handler, and Elysia's mount delegates to a
 * WinterCG fetch handler that never reaches these routes' own lifecycle. Emitting no datapoint
 * for a 5-second-polled probe is strictly better than minting a `health` route series that would
 * write forever, so `http/route-template.ts`'s `routeTemplateOf` is left untouched and the
 * ABSENCE of a datapoint is asserted by `test/health-routes.test.ts`, not merely implied by the
 * file layout.
 *
 * WHY NEITHER ROUTE OWNS ITS PROBE'S DRIVER HERE. `checkDatabaseReady`/`checkWorkersHealthy` are
 * both generic `() => Promise<...>` closures rather than a `Kysely` handle or a concrete worker
 * pipeline type, so this module stays framework/driver-agnostic — matching
 * `test-session-route.ts`'s own structural-dependency convention — and the bounded-timeout
 * `SELECT 1`/worker probe is built once, in the composition root (`runtime/main.ts`), which is
 * the one place that legitimately owns both the `Kysely` handle and whatever background workers
 * this app eventually starts.
 *
 * WHY SECURITY HEADERS ARE APPLIED EXPLICITLY. These are genuine (non-mounted) Elysia routes, so
 * Elysia's own lifecycle hooks WOULD fire for them — but `build-app.ts` never registers the
 * `securityHeaders` plugin (only the manual `applySecurityHeaders` wrapper it applies around the
 * `/api` mount and the auth route), so nothing adds the security header set to a route registered
 * here unless this file does it itself. Applied on every response branch, including 405/503.
 */

/** `GET /health` — process-serving + DB liveness (5s budget). */
export const HEALTH_ROUTE_PATH = '/health';

/** `GET /health/worker` — the in-process worker half's readiness. */
export const HEALTH_WORKER_ROUTE_PATH = '/health/worker';

/** What the composition root injects. */
export interface HealthRoutesDependencies {
  /**
   * Bounded and NEVER throwing (the composition root builds this with
   * `createDatabaseReadinessProbe`, below): resolves `true` when the database round-trips within
   * the 5s budget, `false` on timeout or any error. This route awaits it as-is — the budget is
   * enforced by the closure the caller supplies, not by this file.
   */
  readonly checkDatabaseReady: () => Promise<boolean>;
  /**
   * Optional, and absence means `GET /health/worker` is never registered at all — the same
   * "absent means not registered" shape `sessionMock` uses in `build-app.ts`. `runtime/main.ts`
   * supplies the reviews rating worker's own bounded, never-throwing `checkHealth`
   * (`reviews-rating-worker.ts`) here; a composition root with no background worker pipeline at
   * all would omit this and leave only `GET /health` mounted.
   */
  readonly checkWorkersHealthy?: () => Promise<WorkerHealth>;
}

/** The minimum of Elysia's surface these routes need — structural, so this module imports no
 * framework (the same `RouteRegistrar` shape `test-session-route.ts` declares locally). */
export interface RouteRegistrar {
  all(
    path: string,
    handler: (context: { readonly request: Request }) => Promise<Response>,
  ): unknown;
}

/**
 * The DB liveness budget: a module constant, not a config key — a liveness floor rather than a
 * tuning knob (the same reasoning `packages/messaging`'s bounded Redis probes document for
 * themselves).
 */
export const DATABASE_READINESS_BUDGET_MS = 5_000;

/**
 * Wraps a DB probe so it is BOUNDED (the "5s budget" above) and NEVER throws: resolves `true`
 * when `runProbe` settles within {@link DATABASE_READINESS_BUDGET_MS}, `false` on timeout OR any
 * rejection. Generic over the probe rather than importing `kysely` here (see this file's header)
 * — `runtime/main.ts` supplies `() => sql\`SELECT 1\`.execute(db)`.
 *
 * The losing promise gets a no-op `catch` so a late DB rejection after the race is already
 * decided never surfaces as an unhandled rejection — the same precaution
 * `packages/messaging/src/internal/readiness-probe.ts`'s bounded probe takes, which this mirrors
 * (that helper lives behind `@repo/messaging`'s package boundary, ADR-0001, so this app carries
 * its own copy of the same small shape rather than reaching into it).
 */
export function createDatabaseReadinessProbe(
  runProbe: () => Promise<unknown>,
): () => Promise<boolean> {
  return async function checkDatabaseReady(): Promise<boolean> {
    const attempt = runProbe();
    attempt.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'timed-out'>((resolve) => {
      timer = setTimeout(() => resolve('timed-out'), DATABASE_READINESS_BUDGET_MS);
    });
    try {
      const outcome = await Promise.race([attempt.then(() => 'ready' as const), deadline]);
      return outcome === 'ready';
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

function healthResponse(ready: boolean, mode: AppMode): Response {
  return applySecurityHeaders(
    Response.json({ status: ready ? 'ok' : 'unavailable' }, { status: ready ? 200 : 503 }),
    mode,
  );
}

function methodNotAllowed(mode: AppMode): Response {
  return applySecurityHeaders(new Response(null, { status: 405 }), mode);
}

/**
 * Registers `GET /health` on `app`, at the origin root, BEFORE the `/api` mount — see this file's
 * header for why. Registers `GET /health/worker` too, but only when `deps.checkWorkersHealthy` is
 * given. Unconditionally unauthenticated and rate-limit-exempt: neither route is ever wrapped by
 * `withHttpSecurity`'s CORS/body-cap/rate-limit logic (`build-app.ts` calls this function
 * directly on `app`, the same way it calls the auth mount).
 */
export function mountHealthRoutes(
  app: RouteRegistrar,
  deps: HealthRoutesDependencies,
  mode: AppMode,
): void {
  app.all(HEALTH_ROUTE_PATH, async ({ request }) => {
    if (request.method !== 'GET') {
      return methodNotAllowed(mode);
    }
    const ready = await deps.checkDatabaseReady();
    return healthResponse(ready, mode);
  });

  if (deps.checkWorkersHealthy === undefined) {
    return;
  }
  const checkWorkersHealthy = deps.checkWorkersHealthy;
  app.all(HEALTH_WORKER_ROUTE_PATH, async ({ request }) => {
    if (request.method !== 'GET') {
      return methodNotAllowed(mode);
    }
    const health = await checkWorkersHealthy();
    // Shared with the worker-liveness supervisor, which restarts the process when this same
    // predicate has been false for its whole grace window — two readers of one definition, so
    // "the endpoint says 503" and "the supervisor gave up" can never mean different things.
    const ready = isWorkerHalfHealthy(health);
    return healthResponse(ready, mode);
  });
}
