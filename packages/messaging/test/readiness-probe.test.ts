import { describe, expect, it } from 'vitest';
import {
  boundedReadinessProbe,
  READINESS_PROBE_DEADLINE_MS,
} from '../src/internal/readiness-probe.js';

/** Absorbs timer-vs-`Date.now()` skew on the lower bound below — see that assertion's note. Kept
 * far below the deadline it guards so the assertion still fails loudly if the race is removed. */
const TIMER_SLACK_MS = 50;

describe('boundedReadinessProbe: bounded, never throws', () => {
  it('resolves the operation value when it settles well within the deadline', async () => {
    await expect(boundedReadinessProbe(Promise.resolve('ready'))).resolves.toBe('ready');
  });

  it('resolves undefined — never throws — for a rejecting operation', async () => {
    await expect(
      boundedReadinessProbe(Promise.reject(new Error('redis unreachable'))),
    ).resolves.toBeUndefined();
  });

  it('resolves undefined once the deadline elapses for an operation that never settles, and does so BOUNDED rather than hanging', async () => {
    const neverSettles = new Promise<string>(() => undefined);
    const startedAt = Date.now();
    const result = await boundedReadinessProbe(neverSettles);
    const elapsedMs = Date.now() - startedAt;

    expect(result).toBeUndefined();
    // Bounded to the deadline, not merely "eventually": generous upper margin so container-load
    // jitter cannot flake this, while still failing loudly if the race were ever removed
    // (unbounded would never resolve at all, timing this test out instead of failing it cleanly).
    //
    // The LOWER bound carries a small slack, and it is not cosmetic: this assertion was
    // `>= READINESS_PROBE_DEADLINE_MS` exactly, and it failed on a real run with
    // `expected 1999 to be greater than or equal to 2000`. A `setTimeout(…, 2000)` is not
    // guaranteed to be observable as >=2000ms of `Date.now()` delta — the timer may fire a hair
    // early against a coarser clock, and `Date.now()` truncates to whole milliseconds at both
    // ends. The slack absorbs that without weakening what the assertion proves: with the race
    // removed the probe resolves in single-digit milliseconds, three orders of magnitude below
    // this floor.
    expect(elapsedMs).toBeGreaterThanOrEqual(READINESS_PROBE_DEADLINE_MS - TIMER_SLACK_MS);
    expect(elapsedMs).toBeLessThan(READINESS_PROBE_DEADLINE_MS + 1_000);
  });

  it('a late rejection from the losing operation never surfaces as an unhandled rejection', async () => {
    // The operation rejects AFTER the deadline already won the race — proves the no-op `.catch`
    // on the losing promise, not just the timeout path itself.
    let rejectLate: (error: Error) => void = () => undefined;
    const lateOperation = new Promise<string>((_resolve, reject) => {
      rejectLate = reject;
    });

    const resultPromise = boundedReadinessProbe(lateOperation);
    await expect(resultPromise).resolves.toBeUndefined();

    // If this reject were unhandled, vitest/Node would report it as an unhandled rejection
    // (surfacing as a separate test failure or a process warning) rather than this test passing
    // quietly — there is nothing further to assert beyond letting it happen after resolution.
    rejectLate(new Error('late failure, after the race was already decided'));
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});
