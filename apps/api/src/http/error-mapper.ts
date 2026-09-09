import { ORPCError } from '@orpc/server';
import type { RequestSession } from '@repo/auth';
import type { ApiErrorShape } from '@repo/contracts';
import { isAppError } from '@repo/kernel';
import {
  createModuleObservability,
  failSpan,
  type InstrumentSpecification,
  METRIC_ATTRIBUTE,
} from '@repo/observability';

const obs = createModuleObservability('api');

/** The request-scoped context every HTTP boundary mapping call needs: the route TEMPLATE (never
 * the concrete path — ADR-0009 cardinality), from the routing layer's contract-derived resolver
 * (`route-template.ts`, ADR-0004), and the HTTP method. `session` is the resolved
 * {@link RequestSession}: `requireSession` reads it to make a route session-required; absent when
 * no session dependency was wired (see `http/index.ts`) or when the request carries no valid
 * session. */
export interface HttpRequestContext {
  readonly routeTemplate: string;
  readonly method: string;
  readonly session?: RequestSession;
}

/** `api.http.error`: identical dimensions to the `api.http.request` success histogram
 * (`build-app.ts`'s `API_HTTP_REQUEST_INSTRUMENT`) — that identity is deliberate (ADR-0009),
 * pinned by `test/error-mapper.test.ts`. Exported (not through the package barrel — apps are
 * leaves, ADR-0001) so the test can compare `allowedAttributes` directly rather than re-declaring
 * the list. */
export const API_HTTP_ERROR_INSTRUMENT: InstrumentSpecification = {
  name: 'api.http.error',
  allowedAttributes: [
    METRIC_ATTRIBUTE.Route,
    METRIC_ATTRIBUTE.Method,
    METRIC_ATTRIBUTE.StatusClass,
  ],
};
const apiHttpErrorCounter = obs.createCounter(API_HTTP_ERROR_INSTRUMENT);

function statusClassOf(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

/** The classified wire shape + the HTTP status it maps to (ADR-0008). */
export interface ClassifiedError {
  readonly wire: ApiErrorShape;
  readonly httpStatus: number;
}

/** The generic body a 5xx always carries: no message of its own, no details (ADR-0008 — a server
 * fault is the client's business only as a status code). */
const SERVER_FAULT_MESSAGE = 'Internal server error';

function isServerFault(httpStatus: number): boolean {
  return httpStatus >= 500;
}

/**
 * The one error classification (ADR-0008): `isAppError` detection only — never name/message
 * matching. 5xx bodies replace `message` with a generic string AND DROP `details`; internals never
 * leak. Anything that isn't an `AppError` is `INTERNAL`/500 generic.
 *
 * Dropping `details` on a 5xx is the whole guarantee, not a nicety (review, 2026-09-09):
 * `details` is where an internal error carries the fields that explain it — the `identityId` on
 * `resolveRequestSession`'s fail-closed `InternalError`, a row's column paths on a `rowsAs`
 * mismatch — and genericizing `message` alone shipped every one of them to the caller. A 4xx keeps
 * its details: those are the client's own input, and telling them what they got wrong is the point.
 */
export function classifyError(error: unknown): ClassifiedError {
  if (isAppError(error)) {
    const httpStatus = error.httpStatus;
    if (isServerFault(httpStatus)) {
      return { httpStatus, wire: { code: error.code, message: SERVER_FAULT_MESSAGE } };
    }
    return {
      httpStatus,
      wire: {
        code: error.code,
        message: error.message,
        ...(error.details !== undefined ? { details: error.details } : {}),
      },
    };
  }
  return { httpStatus: 500, wire: { code: 'INTERNAL', message: SERVER_FAULT_MESSAGE } };
}

function failSpanForRequest(error: unknown, context: HttpRequestContext, httpStatus: number): void {
  failSpan(error, {
    errorCounter: apiHttpErrorCounter,
    attributes: {
      route: context.routeTemplate,
      method: context.method,
      status_class: statusClassOf(httpStatus),
    },
    logger: obs.logger,
    message: 'api.http: request failed',
  });
}

/**
 * Converts a caught error into the `ORPCError` a contract handler throws: classifies it, records
 * the error triple via `failSpan` (span omitted => Elysia's active server span), and carries the
 * final wire shape as `data` so {@link finalizeErrorResponse} can use it verbatim — oRPC's own
 * error pipeline would otherwise collapse anything that isn't already an `ORPCError` into a
 * generic, detail-free 500.
 */
export function toOrpcError(
  error: unknown,
  context: HttpRequestContext,
): ORPCError<string, ApiErrorShape> {
  const classified = classifyError(error);
  failSpanForRequest(error, context, classified.httpStatus);
  return new ORPCError(classified.wire.code, {
    status: classified.httpStatus,
    message: classified.wire.message,
    data: classified.wire,
  });
}

/**
 * Maps an error thrown OUTSIDE the oRPC handler pipeline — the per-request session resolution in
 * `http/index.ts`, which runs before `handler.handle()` and so is never seen by `toOrpcError` —
 * into the uniform wire `Response`, recording the error triple via `failSpan`. Without this, an
 * `InternalError` from `resolveRequestSession` (a session whose identity has no `auth.app_user`
 * row) fell through to Elysia's mount-level `onError`, which returns the right status but skips
 * `failSpan`/the histogram — leaving that fail-closed response invisible to the error signal,
 * asymmetric with the anonymous-401 path. Classifying in-band keeps the response shape identical
 * to every other boundary and the observability uniform.
 */
export function errorResponseFor(error: unknown, context: HttpRequestContext): Response {
  const classified = classifyError(error);
  failSpanForRequest(error, context, classified.httpStatus);
  return jsonResponse(classified.wire, classified.httpStatus);
}

function isApiErrorShape(value: unknown): value is ApiErrorShape {
  return (
    typeof value === 'object' &&
    value !== null &&
    'code' in value &&
    typeof (value as { code: unknown }).code === 'string' &&
    'message' in value
  );
}

interface OrpcErrorBody {
  readonly code?: string;
  readonly message?: string;
  readonly data?: unknown;
}

/** Reads an upstream error body, resolving to an empty body when it is not JSON — see the call
 * site in {@link finalizeErrorResponse} for why this never rejects. */
async function readErrorBody(response: Response): Promise<OrpcErrorBody> {
  try {
    return ((await response.json()) ?? {}) as OrpcErrorBody;
  } catch {
    return {};
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * The single boundary error mapper: every non-2xx response the oRPC adapter produces is
 * finalized into the uniform `{ code, message, details? }` wire shape before it leaves the app.
 * Covers two origins — errors {@link toOrpcError} already shaped (its `data` IS the final body,
 * so this branch does NOT call `failSpan` again — the mapper's two integration points are
 * mutually exclusive per request) and errors oRPC produces itself before a handler ever runs
 * (contract input validation failures arrive as `BAD_REQUEST`, mapped here to `VALIDATION`/400;
 * anything else unmapped falls back to `INTERNAL`/500 generic — THIS is the one branch that still
 * calls `failSpan`, since no handler ran and `toOrpcError` never saw the error).
 */
export async function finalizeErrorResponse(
  response: Response,
  context: HttpRequestContext,
): Promise<Response> {
  if (response.ok) {
    return response;
  }
  // The parse is guarded because this function is the LAST thing between an error and the wire
  // (review, 2026-09-09): a body that is not JSON at all — a proxy's HTML error page, a truncated
  // response — used to reject here and throw straight out of the handler, skipping the uniform
  // wire shape, the error signal below, and every header the caller wraps around this response.
  // An unreadable body is simply an error with nothing to read: fall through to the generic
  // mapping with `code` undefined, which is the same path an unrecognised oRPC code takes.
  const body = await readErrorBody(response);
  if (isApiErrorShape(body.data)) {
    return jsonResponse(body.data, response.status);
  }
  const wire: ApiErrorShape =
    body.code === 'BAD_REQUEST'
      ? { code: 'VALIDATION', message: 'Input validation failed' }
      : { code: 'INTERNAL', message: SERVER_FAULT_MESSAGE };
  failSpanForRequest(
    new Error(`oRPC pipeline error before a handler ran: ${body.code ?? '(unknown)'}`),
    context,
    response.status,
  );
  return jsonResponse(wire, response.status);
}
