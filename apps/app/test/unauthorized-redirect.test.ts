/**
 * 401 handled ROUTER-LEVEL, EXACTLY ONCE (ADR-0012) — the property that lets every feature ignore
 * authentication entirely.
 *
 * Driven through a real `QueryClient` with real queries and mutations, because the thing being
 * tested is a cache subscription: calling the handler directly would prove only that a function
 * can be called.
 */
import { ERROR_CODE } from '@repo/kernel';
import { MutationObserver, QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { ApiError, installUnauthorizedRedirect } from '../src/shared/errors/index.js';

function client(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

describe('installUnauthorizedRedirect', () => {
  it('redirects on a query that fails with UNAUTHORIZED', async () => {
    const queryClient = client();
    const redirects: string[] = [];
    installUnauthorizedRedirect(
      queryClient,
      (returnTo) => redirects.push(returnTo),
      () => '/orders',
    );

    await queryClient
      .fetchQuery({
        queryKey: ['anything'],
        queryFn: () => Promise.reject(new ApiError(ERROR_CODE.Unauthorized, 'nope', 401)),
      })
      .catch(() => undefined);

    expect(redirects).toEqual(['/orders']);
  });

  /** A session expires as easily under a submit as under a read. A 401 handler that only watched
   * queries would strand the user on a form that silently refuses to save. */
  it('redirects on a MUTATION that fails with UNAUTHORIZED', async () => {
    const queryClient = client();
    const redirects: string[] = [];
    installUnauthorizedRedirect(
      queryClient,
      (returnTo) => redirects.push(returnTo),
      () => '/orders',
    );

    const observer = new MutationObserver(queryClient, {
      mutationFn: () => Promise.reject(new ApiError(ERROR_CODE.Unauthorized, 'nope', 401)),
    });
    await observer.mutate().catch(() => undefined);

    expect(redirects).toEqual(['/orders']);
  });

  it('ignores every other failure — features still own their own errors', async () => {
    const queryClient = client();
    const redirects: string[] = [];
    installUnauthorizedRedirect(
      queryClient,
      (returnTo) => redirects.push(returnTo),
      () => '/',
    );

    for (const code of [ERROR_CODE.Forbidden, ERROR_CODE.NotFound, ERROR_CODE.Internal] as const) {
      await queryClient
        .fetchQuery({
          queryKey: [code],
          queryFn: () => Promise.reject(new ApiError(code, 'nope', 500)),
        })
        .catch(() => undefined);
    }

    expect(redirects).toEqual([]);
  });

  it('stops redirecting after teardown', async () => {
    const queryClient = client();
    const redirects: string[] = [];
    const uninstall = installUnauthorizedRedirect(
      queryClient,
      (returnTo) => redirects.push(returnTo),
      () => '/',
    );
    uninstall();

    await queryClient
      .fetchQuery({
        queryKey: ['after-teardown'],
        queryFn: () => Promise.reject(new ApiError(ERROR_CODE.Unauthorized, 'nope', 401)),
      })
      .catch(() => undefined);

    expect(redirects).toEqual([]);
  });
});
