import { toApiError } from '../errors/index.js';

/**
 * `shared/observability` — the thin, provider-optional error-reporting wrapper (ADR-0012).
 *
 * THIS FILE IS THE SPA'S ADR-0008 BOUNDARY. The browser has no `@repo/observability` facade (that
 * package is a server-side pino/OTel wiring), so "errors are handled once, at a boundary" cashes
 * out here: everything else in this app propagates, and exactly one place turns an error into a
 * report.
 *
 * That one place is `router.tsx`'s `defaultErrorComponent`, named here explicitly — a boundary
 * with no caller is a claim rather than a boundary.
 *
 * This module is listed in `tools/arch-checks/src/no-core-logging.ts`'s app allowlist for the same
 * reason it is the boundary — the gate's registry, not an exemption.
 */

/** A provider adapter (Sentry/Rollbar/whatever). Plain function, so no vendor type escapes into a
 * feature and the wiring stays in the composition root (`main.tsx`, ADR-0005). */
export type ErrorSink = (error: Error, context: Readonly<Record<string, unknown>>) => void;

let sink: ErrorSink | undefined;

/** Wires the provider from the composition root (`main.tsx`) when a product has one; absent ⇒
 * development console only, which is this repository's shipped state. Returns a teardown for
 * tests. */
export function setErrorSink(next: ErrorSink | undefined): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

export const observability = {
  /**
   * Reports a failure once. Normalizes through `toApiError` first so the reported shape is the
   * same one the UI branched on — a report that disagrees with what the user saw is worse than no
   * report.
   *
   * With no provider wired this writes to the console in development only. `import.meta.env.DEV`
   * is a Vite build-time constant, so the branch (and the console call) is removed entirely from
   * a production bundle rather than merely skipped at runtime.
   */
  reportError(error: unknown, context: Readonly<Record<string, unknown>> = {}): void {
    const apiError = toApiError(error);
    const enrichedContext = { code: apiError.code, httpStatus: apiError.httpStatus, ...context };
    if (sink !== undefined) {
      sink(apiError, enrichedContext);
      return;
    }
    if (import.meta.env.DEV) {
      console.error(apiError, enrichedContext);
    }
  },
};
