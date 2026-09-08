/**
 * The shared bounded-timeout shape behind `WorkerHandle.isReady()` (`worker.ts`) and
 * `getRegisteredSchedulerIds` (`repeatable.ts`) — both are readiness PROBES ('s
 * amendment item 2: the `/health/worker` endpoint awaits them inline on an inbound request), so
 * neither may hang past a small ceiling nor ever reject. Mirrors
 * `sliding-window-rate-limiter.ts`'s `withDeadline` (same reasoning: an unbounded call on an
 * inbound-request path turns "Redis is slow" into "the request hangs"), factored out here because
 * both call sites in this module need the identical bounded-and-non-throwing shape.
 *
 * THE BOUND IS PER PROBE, AND THE CALLER OWNS THE COMPOSED ONE. A caller that awaits N of these
 * one after another has a ceiling of N deadlines, not one, and this file's "may not hang past a
 * small ceiling" says nothing about that — which is how `/health/worker` came to take a measured
 * 8.01s against a downed Redis while this constant read 2000ms (runtime verification;
 * `@repo/example-context`'s `checkHealth` awaited one lookup per registered schedule inside a
 * `for` loop, so the endpoint's real ceiling grew with the pipeline). Probe concurrently.
 * `packages/example-context/test-integration/check-health.test.ts`'s ceiling case is the measurement that
 * keeps that true for the one caller on an inbound-request path.
 */

/**
 * Order of magnitude above a healthy `waitUntilReady()`/`getJobSchedulers()` round trip against a
 * local or same-VPC Redis (sub-50ms) — a liveness floor, not a tuning knob, so it is a module
 * constant rather than a config key (same reasoning as `sliding-window-rate-limiter.ts`'s
 * `REDIS_CALL_DEADLINE_MS`).
 */
export const READINESS_PROBE_DEADLINE_MS = 2_000;

/**
 * Races `operation` against {@link READINESS_PROBE_DEADLINE_MS} and NEVER throws: resolves the
 * operation's value on time, `undefined` on timeout OR any rejection. The losing promise gets a
 * no-op `catch` so a late rejection after the race is already decided never surfaces as an
 * unhandled rejection (the same precaution `withDeadline` in `sliding-window-rate-limiter.ts`
 * takes).
 *
 * @internal exported for `test/readiness-probe.test.ts` only (relative import, not through the
 * barrel) — the bounded/non-throwing contract is generic and needs no live Redis to prove; the
 * BullMQ-specific semantics that consume it (`WorkerHandle.isReady`, `getRegisteredSchedulerIds`)
 * have their own live-Redis proofs in `test-integration/`.
 */
export async function boundedReadinessProbe<T>(operation: Promise<T>): Promise<T | undefined> {
  operation.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), READINESS_PROBE_DEADLINE_MS);
  });
  try {
    return await Promise.race([operation, deadline]);
  } catch {
    // `operation` rejected before the deadline fired — never throw out of a readiness probe.
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
