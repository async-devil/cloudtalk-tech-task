/**
 * The shared kernel's frozen surfaces: the ONE client, and the ONE error shape everything failed
 * becomes.
 */
import { ERROR_CODE } from '@repo/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import { API_BASE_URL, apiClient } from '../src/shared/api/index.js';
import { ApiError, toApiError } from '../src/shared/errors/index.js';
import {
  bootstrapPayload,
  type FetchStub,
  jsonResponse,
  stubBootstrapFetch,
  unauthorizedResponse,
  wireError,
} from './harness/api-responses.js';

let stub: FetchStub | undefined;

afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe('apiClient', () => {
  it('calls the contract-declared path under the configured base URL', async () => {
    stub = stubBootstrapFetch(() => jsonResponse(bootstrapPayload()));

    await apiClient.session.bootstrap();

    const request = stub.requests[0];
    expect(request).toBeDefined();
    // The path comes from `appContract`, not from a string in this app — that is what "the
    // contract is the SDK" means in practice (ADR-0004).
    expect(request?.url).toBe(`${API_BASE_URL}/session/bootstrap`);
    expect(request?.method).toBe('GET');
  });

  /**
   * The session cookie is `HttpOnly`, so this flag is the ONLY thing that sends it, and the SPA
   * is always cross-origin from the api in development.
   *
   * This assertion is NOT vacuous, measured rather than assumed: `new Request(url).credentials`
   * is `'same-origin'` in this suite's environment (checked directly), so the value below can
   * only be `'include'` because `shared/api` re-creates the request with it — removing that line
   * turns this test red, which was verified by doing exactly that.
   */
  it('sends credentials with every request', async () => {
    stub = stubBootstrapFetch(() => jsonResponse(bootstrapPayload()));

    await apiClient.session.bootstrap();

    expect(stub.requests[0]?.credentials).toBe('include');
  });

  it('returns the parsed payload on success', async () => {
    stub = stubBootstrapFetch(() => jsonResponse(bootstrapPayload()));

    await expect(apiClient.session.bootstrap()).resolves.toEqual(bootstrapPayload());
  });
});

/** Drives the REAL client against the stubbed transport and normalizes whatever comes back —
 * `.catch(toApiError)` inline would widen the result type to "payload or error" and lose every
 * assertion below to a type narrowing dance. */
async function bootstrapError(): Promise<ApiError> {
  try {
    await apiClient.session.bootstrap();
  } catch (error) {
    return toApiError(error);
  }
  throw new Error('expected the bootstrap call to fail');
}

describe('toApiError', () => {
  it('carries the api wire shape through verbatim: code, message and status', async () => {
    stub = stubBootstrapFetch(() => unauthorizedResponse());

    const error = await bootstrapError();

    expect(error).toBeInstanceOf(ApiError);
    expect(error.code).toBe(ERROR_CODE.Unauthorized);
    expect(error.message).toBe('authentication required');
    expect(error.httpStatus).toBe(401);
  });

  /**
   * The product's OWN codes are the reason the api's body wins over oRPC's status-derived code:
   * oRPC maps 503 back to its own vocabulary and has never heard of `MAGIC_LINK_SEND_FAILED`,
   * which the sign-in UI keys on directly (`@repo/kernel`'s ERROR_CODE note).
   */
  it('prefers the api wire code over the transport status mapping', async () => {
    stub = stubBootstrapFetch(() =>
      wireError(ERROR_CODE.MagicLinkSendFailed, 'could not send the link', 503),
    );

    const error = await bootstrapError();

    expect(error.code).toBe(ERROR_CODE.MagicLinkSendFailed);
  });

  it('turns a network failure into a generic INTERNAL error, leaking nothing', () => {
    const error = toApiError(new TypeError('Failed to fetch: ECONNREFUSED 10.0.0.5:5432'));

    expect(error.code).toBe(ERROR_CODE.Internal);
    expect(error.httpStatus).toBe(500);
    // The original text — which can carry internal hosts, ports and stack detail — must not
    // survive into something a component may render.
    expect(error.message).not.toContain('ECONNREFUSED');
  });

  it('rejects a non-conforming body rather than trusting it', async () => {
    // A misconfigured proxy answering with HTML, or any server that is not this api: the shape is
    // PARSED (ADR-0008), so an unexpected `code` can never steer UI behaviour.
    stub = stubBootstrapFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502 }));

    const error = await bootstrapError();

    expect(error.code).toBe(ERROR_CODE.Internal);
  });

  it('rejects a body whose code is not in the kernel vocabulary', () => {
    const error = toApiError({
      status: 418,
      data: { body: { code: 'DEFINITELY_NOT_A_KERNEL_CODE', message: 'nope' } },
    });

    expect(error.code).toBe(ERROR_CODE.Internal);
  });

  it('is idempotent — an ApiError passes through unchanged', () => {
    const original = new ApiError(ERROR_CODE.NotFound, 'gone', 404);

    expect(toApiError(original)).toBe(original);
  });

  it('keeps structured details when the api sent them', () => {
    const error = toApiError({
      status: 400,
      data: { body: { code: ERROR_CODE.Validation, message: 'bad', details: { field: 'text' } } },
    });

    expect(error.details).toEqual({ field: 'text' });
  });
});
