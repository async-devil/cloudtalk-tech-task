/**
 * The worker-liveness supervisor: a permanently worker-dead api must exit so
 * `restart: unless-stopped` recovers it, and a BLIP must not.
 *
 * Driven on an injected clock and an injected interval, so every case is deterministic and the
 * suite spends no wall time — the thing under test is a policy over time, not a timer.
 */

import { describe, expect, it } from 'vitest';
import {
  isWorkerHalfHealthy,
  startWorkerLivenessSupervisor,
  type WorkerHealth,
  type WorkerLivenessEvent,
  type WorkerLivenessFailure,
} from '../src/runtime/worker-liveness.js';

const HEALTHY: WorkerHealth = {
  workersReady: true,
  missingSchedulerIds: [],
  checkedSchedulerIds: ['retention:auth'],
  checkedWorkerCount: 7,
};
/** The observed shape: workers never became ready, schedulers ARE registered (they were awaited
 * during `start()` and succeeded — only a worker's connection broke). */
const WORKER_DEAD: WorkerHealth = { ...HEALTHY, workersReady: false };
const SCHEDULER_MISSING: WorkerHealth = {
  ...HEALTHY,
  missingSchedulerIds: ['retention:auth'],
};

interface Harness {
  tick: (times?: number) => Promise<void>;
  advance: (ms: number) => void;
  readonly failures: WorkerLivenessFailure[];
  readonly events: WorkerLivenessEvent[];
  close: () => void;
}

function harness(health: () => WorkerHealth, graceMs = 30_000, intervalMs = 5_000): Harness {
  let clock = 1_000_000;
  let fire: () => void = () => undefined;
  const failures: WorkerLivenessFailure[] = [];
  const events: WorkerLivenessEvent[] = [];

  const supervisor = startWorkerLivenessSupervisor({
    checkHealth: () => Promise.resolve(health()),
    onUnrecoverable: (failure) => failures.push(failure),
    log: (event) => events.push(event),
    now: () => clock,
    graceMs,
    intervalMs,
    setIntervalFn: ((callback: () => void) => {
      fire = callback;
      return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
    }) as unknown as typeof setInterval,
    clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
  });

  return {
    tick: async (times = 1) => {
      for (let i = 0; i < times; i += 1) {
        fire();
        // One microtask drain per tick: `probe` is async and the assertions read what it recorded.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
      }
    },
    advance: (ms) => {
      clock += ms;
    },
    failures,
    events,
    close: () => supervisor.close(),
  };
}

describe('worker-liveness supervisor', () => {
  it('never gives up while the worker half is healthy', async () => {
    const h = harness(() => HEALTHY);
    for (let i = 0; i < 20; i += 1) {
      await h.tick();
      h.advance(5_000);
    }
    expect(h.failures).toHaveLength(0);
    expect(h.events).toHaveLength(0);
    h.close();
  });

  it('gives up once the worker half has been unhealthy for the whole grace window', async () => {
    const h = harness(() => WORKER_DEAD);

    await h.tick(); // opens the window
    expect(h.failures).toHaveLength(0);

    h.advance(29_000);
    await h.tick(); // still inside the window
    expect(h.failures).toHaveLength(0);

    h.advance(2_000); // 31s of continuous unhealth
    await h.tick();
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]?.unhealthyForMs).toBeGreaterThanOrEqual(30_000);
    expect(h.failures[0]?.workersReady).toBe(false);
    h.close();
  });

  it('does NOT give up for a blip — one healthy probe resets the clock completely', async () => {
    // The distinction the grace window exists for: a Redis failover looks exactly like the fatal
    // case for a few seconds. Unhealthy for 29s, one good probe, then unhealthy again for 29s —
    // 58s of mostly-unhealthy time, and no restart, because it was never CONTINUOUS.
    let healthy = false;
    const h = harness(() => (healthy ? HEALTHY : WORKER_DEAD));

    await h.tick();
    h.advance(29_000);
    await h.tick();
    expect(h.failures).toHaveLength(0);

    healthy = true;
    await h.tick();
    expect(h.events.at(-1)).toEqual({ kind: 'recovered', unhealthyForMs: 29_000 });

    healthy = false;
    await h.tick();
    h.advance(29_000);
    await h.tick();
    expect(h.failures).toHaveLength(0);
    h.close();
  });

  it('gives up exactly once, however long the process lingers', async () => {
    const h = harness(() => WORKER_DEAD);
    await h.tick();
    h.advance(60_000);
    await h.tick(10);
    expect(h.failures).toHaveLength(1);
    h.close();
  });

  it('treats a missing scheduler as unhealthy too, not only unready workers', async () => {
    const h = harness(() => SCHEDULER_MISSING);
    await h.tick();
    h.advance(31_000);
    await h.tick();
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]?.missingSchedulerIds).toStrictEqual(['retention:auth']);
    h.close();
  });

  it('counts a THROWING probe as unhealthy rather than dying with it', async () => {
    // `checkHealth` is documented as never throwing. The supervisor does not take that on trust:
    // the one component that must survive a broken Redis is the one that notices it is broken.
    let clock = 0;
    const failures: WorkerLivenessFailure[] = [];
    let fire: () => void = () => undefined;
    const supervisor = startWorkerLivenessSupervisor({
      checkHealth: () => Promise.reject(new Error('redis exploded')),
      onUnrecoverable: (failure) => failures.push(failure),
      log: () => undefined,
      now: () => clock,
      graceMs: 30_000,
      intervalMs: 5_000,
      setIntervalFn: ((callback: () => void) => {
        fire = callback;
        return { unref: () => undefined } as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval,
      clearIntervalFn: (() => undefined) as unknown as typeof clearInterval,
    });

    fire();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    clock += 31_000;
    fire();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(failures).toHaveLength(1);
    supervisor.close();
  });

  it('shares one definition of "the worker half is up" with the route', () => {
    expect(isWorkerHalfHealthy(HEALTHY)).toBe(true);
    expect(isWorkerHalfHealthy(WORKER_DEAD)).toBe(false);
    expect(isWorkerHalfHealthy(SCHEDULER_MISSING)).toBe(false);
  });
});
