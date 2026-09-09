import { AppError, ERROR_CODE } from '@repo/kernel';

/**
 * The body-cap error: `ValidationError` subclass semantics; code `VALIDATION`, httpStatus 413 via
 * the mapper's cap branch — no new wire code. Kernel's own `ValidationError` fixes `httpStatus`
 * to the literal `400` (its own frozen taxonomy, `packages/kernel/src/errors/taxonomy.ts`), so a
 * 413 variant cannot literally extend it — this local `AppError` subclass carries the SAME wire
 * code (`VALIDATION`) with a different `httpStatus`, which is all `classifyError`
 * (`http/error-mapper.ts`) actually reads; no kernel taxonomy change, no new `ERROR_CODE` member.
 */
export class BodyTooLargeError extends AppError {
  readonly code = ERROR_CODE.Validation;
  readonly httpStatus = 413 as const;
  readonly retryable = false as const;
}

export interface BodyCapOptions {
  readonly limitBytes: number;
}

/**
 * Fully drains (never cancels) a request body before rejecting it. This app mounts its routes
 * (`Elysia#mount`), which hands handlers a `Request` built via `new Request(url, originalRequest)`
 * — a clone over the original body stream. Calling `.cancel()` on that clone's body stream leaves
 * the underlying connection never fully drained and the CLIENT hangs indefinitely waiting for a
 * response that was already sent (verified empirically); fully consuming the stream instead does
 * not. The bandwidth cost of reading a body already known to be over-cap is the accepted trade for
 * a connection that never hangs.
 */
async function drainBody(request: Request): Promise<void> {
  if (request.body === null) {
    return;
  }
  const reader = request.body.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) {
      break;
    }
  }
}

/**
 * Enforces `HTTP_BODY_LIMIT_BYTES` before any parser sees the body. Fast path: reject on an
 * honest, over-cap `Content-Length` without reading a byte. Otherwise streams and counts —
 * catching a MISSING or LYING `Content-Length` under a bigger chunked body, so a lying length
 * cannot bypass the cap. Returns a fresh `Request` with a buffered body (safe to read again
 * downstream) when under the cap; throws {@link BodyTooLargeError} when over it. The connection
 * stays healthy either way: the stream is always fully drained or cancelled before returning.
 */
export async function enforceBodyCap(request: Request, options: BodyCapOptions): Promise<Request> {
  if (request.body === null) {
    return request;
  }

  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > options.limitBytes) {
    await drainBody(request);
    throw new BodyTooLargeError(`request body exceeds ${options.limitBytes} bytes`);
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > options.limitBytes) {
      // Drain the REST of the stream too (same reasoning as `drainBody`'s header note) — this
      // reader has already consumed part of the stream, so finish reading through it rather than
      // cancelling.
      for (;;) {
        const next = await reader.read();
        if (next.done) {
          break;
        }
      }
      throw new BodyTooLargeError(`request body exceeds ${options.limitBytes} bytes`);
    }
    chunks.push(value);
  }

  const buffered = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    buffered.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffered.byteLength > 0
    ? new Request(request.url, { method: request.method, headers: request.headers, body: buffered })
    : new Request(request.url, { method: request.method, headers: request.headers });
}
