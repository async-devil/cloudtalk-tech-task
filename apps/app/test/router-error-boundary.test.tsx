import { QueryClient } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAppRouter } from '../src/router.js';
import { setErrorSink } from '../src/shared/observability/index.js';
import { type FetchStub, jsonResponse, stubBootstrapFetch } from './harness/api-responses.js';

/**
 * THE APP'S ADR-0008 BOUNDARY.
 *
 * `shared/observability` describes itself as "the SPA's boundary" — this suite is what makes the
 * claim true rather than aspirational. It drives a REAL navigation whose bootstrap call fails, and
 * asserts on what the boundary did.
 *
 * The failure is injected at the transport (a 500 from `globalThis.fetch`), not by throwing inside
 * a fake component: the point is that a failure anywhere in a route's data path reaches exactly one
 * reporter, and a hand-thrown error inside the boundary itself would prove only that React renders
 * error components.
 */

let stub: FetchStub | undefined;
let restoreSink: (() => void) | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
  restoreSink?.();
  restoreSink = undefined;
  cleanup();
});

async function renderFailingNavigation() {
  // A 500 rather than a 401: `shared/session` deliberately translates 401 into "no session" and
  // the guard redirects, so a 401 would never reach an error boundary at all. 500 is the shape
  // that must.
  stub = stubBootstrapFetch(() => jsonResponse({ code: 'INTERNAL', message: 'boom' }, 500));
  const sink = vi.fn();
  restoreSink = setErrorSink(sink);

  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const router = createAppRouter({
    queryClient,
    history: createMemoryHistory({ initialEntries: ['/'] }),
  });
  await router.load();
  render(<RouterProvider router={router} />);
  return { sink };
}

describe('the router error boundary', () => {
  it('reports a failed route through `observability` exactly once', async () => {
    const { sink } = await renderFailingNavigation();

    await waitFor(() => {
      expect(sink).toHaveBeenCalledTimes(1);
    });
    // The report carries the NORMALIZED error and its boundary — a report that disagreed with what
    // the user saw would be worse than no report.
    const [reported, context] = sink.mock.calls[0] ?? [];
    expect((reported as Error).name).toBe('ApiError');
    expect(context).toMatchObject({ boundary: 'router', code: 'INTERNAL', httpStatus: 500 });
  });

  it('renders registered copy, never the backend’s own operator-facing message', async () => {
    await renderFailingNavigation();

    const alert = await screen.findByTestId('route-error');
    // The registered `INTERNAL` copy…
    expect(alert.textContent).toBe('Something went wrong. Please try again.');
    // …and specifically NOT the wire `message`, which is written for a log.
    expect(alert.textContent).not.toContain('boom');
  });
});
