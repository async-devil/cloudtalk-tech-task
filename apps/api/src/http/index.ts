import { OpenAPIHandler } from '@orpc/openapi/fetch';
import { resolveRequestSession, type SessionMiddlewareDependencies } from '@repo/auth';
import { ERROR_CODE } from '@repo/kernel';
import type { Kysely } from 'kysely';
import { createAppRouter } from '../routes/app.router.js';
import type { HttpRequestContext } from './error-mapper.js';
import { errorResponseFor, finalizeErrorResponse } from './error-mapper.js';
import { routeTemplateOf } from './route-template.js';
import {
  isReviewSubmissionRoute,
  type RateLimiters,
  withRetryAfterHeader,
} from './security/rate-limit.js';

export interface HttpHandlerDeps {
  /** Optional so callers with no interest in auth (a wiring-only test) keep constructing the
   * handler unchanged. Absent ⇒ every request resolves `session: undefined`, so `requireSession`
   * always 401s (fail closed). */
  readonly session?: SessionMiddlewareDependencies;
  /** The UnauthenticatedPost/AnonymousRead/ReviewSubmission halves of the rate-limit policy —
   * optional (same precedent as `session`) so suites with no interest in the security baseline
   * keep constructing the handler unchanged. The Auth bucket is consulted at the `/api/auth/*`
   * route in `runtime/build-app.ts`, not here. */
  readonly rateLimiters?: RateLimiters;
  /** The `products`/`reviews` routers' shared Postgres handle — optional, same precedent, so a
   * suite exercising only `session` (or the wiring around it) keeps constructing the handler
   * unchanged; absence fails each product/review route closed with a typed 500
   * (`routes/require-db.ts`), never a crash. */
  readonly db?: Kysely<unknown>;
}

/**
 * Builds the Fetch-API handler `Elysia#mount('/api', ...)` delegates to: an oRPC `OpenAPIHandler`
 * implementing `appContract` (`session`, `products`, `reviews`) over its declared `method`/`path`
 * routes, with every non-2xx response finalized into the uniform wire error shape before it leaves
 * the app.
 *
 * The per-request {@link HttpRequestContext} (route TEMPLATE + method + resolved session) is
 * resolved once here and passed as the oRPC initial context, so every handler that catches and
 * calls `toOrpcError` receives the same context this function passes to `finalizeErrorResponse`
 * afterward. Session resolution (`resolveRequestSession`) happens here — not in an Elysia
 * `.derive` — because the mounted oRPC handler bypasses Elysia's derive chain entirely
 * (`runtime/build-app.ts`'s header note).
 */
export function createHttpHandler(deps: HttpHandlerDeps): (request: Request) => Promise<Response> {
  const handler = new OpenAPIHandler(createAppRouter(deps.db !== undefined ? { db: deps.db } : {}));

  return async (request: Request): Promise<Response> => {
    const baseContext = {
      routeTemplate: routeTemplateOf(new URL(request.url).pathname),
      method: request.method,
    };
    // Session resolution runs BEFORE `handler.handle()`, so its throws (an `InternalError` from
    // `resolveRequestSession` — a session whose identity has no `auth.app_user` row) never reach a
    // handler's `toOrpcError`. Map them here through the same observed boundary (`errorResponseFor`)
    // rather than letting them fall through to the mount's `onError`, which skips `failSpan`/the
    // histogram. `requireSession`'s own 401 (anonymous) still travels the in-handler path: an
    // absent session is `undefined`, not a throw.
    let session: Awaited<ReturnType<typeof resolveRequestSession>>;
    if (deps.session !== undefined) {
      try {
        session = await resolveRequestSession(deps.session, request.headers);
      } catch (error) {
        return errorResponseFor(error, baseContext);
      }
    }
    // The no-session-keyed halves of the rate-limit policy — run after session resolution
    // (header-only; still strictly before the oRPC handler's own JSON body parse just below it, so
    // the ordering law — "before body parsing" — holds). `unauthenticated-post` and
    // `anonymous-read` (ADR-0019) are mutually exclusive by method (POST vs. GET), so only one of
    // the two branches below can ever fire for a given request.
    if (deps.rateLimiters !== undefined && session === undefined && request.method === 'POST') {
      try {
        await deps.rateLimiters.checkUnauthenticatedPost(request);
      } catch (error) {
        return withRetryAfterHeader(errorResponseFor(error, baseContext), error);
      }
    }
    if (deps.rateLimiters !== undefined && session === undefined && request.method === 'GET') {
      try {
        await deps.rateLimiters.checkAnonymousRead(request);
      } catch (error) {
        return withRetryAfterHeader(errorResponseFor(error, baseContext), error);
      }
    }
    // ADR-0019's `review-submission` bucket: a RESOLVED session hitting exactly `reviews.submit`/
    // `reviews.update` — never `reviews.remove` (SPEC-0003's own bucket list omits it) and never
    // any other session-required route. Keyed by the session's internal id, never an IP.
    if (
      deps.rateLimiters !== undefined &&
      session !== undefined &&
      isReviewSubmissionRoute(request.method, baseContext.routeTemplate)
    ) {
      try {
        await deps.rateLimiters.checkReviewSubmission(session.userId);
      } catch (error) {
        return withRetryAfterHeader(errorResponseFor(error, baseContext), error);
      }
    }

    const context: HttpRequestContext = {
      ...baseContext,
      ...(session !== undefined ? { session } : {}),
    };
    const result = await handler.handle(request, { context });
    if (!result.matched) {
      // Uniform wire shape, deliberately WITHOUT `failSpan`: no error object exists and nothing
      // was "handled" — recording one here would pollute the error signal with routing noise. The
      // request still counts in the success histogram as `status_class: '4xx'`, `route: 'other'`
      // (build-app.ts) — the one deliberate asymmetry.
      return new Response(JSON.stringify({ code: ERROR_CODE.NotFound, message: 'Not Found' }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
    }
    return finalizeErrorResponse(result.response, context);
  };
}
