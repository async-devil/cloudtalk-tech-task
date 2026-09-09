/**
 * The provider-optional wrappers. Their whole value is that a feature imports THESE and never a
 * vendor SDK, so swapping providers touches two files — which is only true if the unwired path is
 * genuinely inert and the wired path genuinely delegates.
 */
import { ERROR_CODE } from '@repo/kernel';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type AnalyticsSink, analytics, setAnalyticsSink } from '../src/shared/analytics/index.js';
import { ApiError } from '../src/shared/errors/index.js';
import { type ErrorSink, observability, setErrorSink } from '../src/shared/observability/index.js';

const teardowns: Array<() => void> = [];

afterEach(() => {
  while (teardowns.length > 0) {
    teardowns.pop()?.();
  }
  vi.restoreAllMocks();
});

function wireAnalytics(sink: AnalyticsSink): void {
  teardowns.push(setAnalyticsSink(sink));
}

function wireErrors(sink: ErrorSink): void {
  teardowns.push(setErrorSink(sink));
}

describe('analytics', () => {
  it('is a no-op with no provider wired — a product that wires none still runs', () => {
    expect(() => analytics.track('sign-in.link-requested', { count: 1 })).not.toThrow();
  });

  it('delegates name and properties to the wired provider', () => {
    const calls: Array<[string, Readonly<Record<string, unknown>>]> = [];
    wireAnalytics((name, properties) => calls.push([name, properties]));

    analytics.track('sign-in.link-requested', { count: 1 });

    expect(calls).toEqual([['sign-in.link-requested', { count: 1 }]]);
  });

  /** Analytics must never break a user flow: a provider that throws is swallowed, and the caller
   * — which is a click handler — continues. */
  it('swallows a provider that throws', () => {
    wireAnalytics(() => {
      throw new Error('provider exploded');
    });

    expect(() => analytics.track('sign-in.link-requested')).not.toThrow();
  });

  it('stops delegating once the provider is torn down', () => {
    const calls: string[] = [];
    const restore = setAnalyticsSink((name) => calls.push(name));
    restore();

    analytics.track('sign-in.link-requested');

    expect(calls).toEqual([]);
  });
});

describe('observability.reportError', () => {
  it('normalizes through toApiError before reporting — the report matches what the UI saw', () => {
    const reports: Array<{ error: Error; context: Readonly<Record<string, unknown>> }> = [];
    wireErrors((error, context) => reports.push({ error, context }));

    observability.reportError(new TypeError('Failed to fetch'), { route: '/sign-in' });

    const report = reports[0];
    expect(report?.error).toBeInstanceOf(ApiError);
    expect(report?.context).toMatchObject({
      code: ERROR_CODE.Internal,
      httpStatus: 500,
      route: '/sign-in',
    });
  });

  it('passes a typed api failure through with its own code', () => {
    const reports: Array<Readonly<Record<string, unknown>>> = [];
    wireErrors((_error, context) => reports.push(context));

    observability.reportError(new ApiError(ERROR_CODE.Conflict, 'already exists', 409));

    expect(reports[0]).toMatchObject({ code: ERROR_CODE.Conflict, httpStatus: 409 });
  });

  /** With no provider, development still gets the failure on the console — and nothing else does.
   * The console call is this app's ONE boundary (`no-core-logging`'s app allowlist). */
  it('falls back to the console in development when no provider is wired', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    observability.reportError(new ApiError(ERROR_CODE.NotFound, 'gone', 404));

    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('does not touch the console once a provider is wired', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    wireErrors(() => undefined);

    observability.reportError(new ApiError(ERROR_CODE.NotFound, 'gone', 404));

    expect(consoleError).not.toHaveBeenCalled();
  });
});
