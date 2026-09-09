import {
  type Attributes,
  type Counter,
  type Gauge,
  type Histogram,
  type Meter,
  type MeterProvider,
  metrics,
  type UpDownCounter,
} from '@opentelemetry/api';
import { APP_MODE } from '@repo/config';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/runtime/build-app.js';
import {
  createDatabaseReadinessProbe,
  DATABASE_READINESS_BUDGET_MS,
  HEALTH_ROUTE_PATH,
  HEALTH_WORKER_ROUTE_PATH,
  type HealthRoutesDependencies,
} from '../src/runtime/health-routes.js';
import type { WorkerHealth } from '../src/runtime/worker-liveness.js';

/**
 * (2026-08-09 amendment items 2/3): `GET /health`/`GET /health/worker`.
 *
 * The "NO api.http.request datapoint" assertion (amendment item 3) needs a real, test-local OTel
 * metrics pipeline to check — `build-app.ts`'s `httpRequestHistogram` resolves its underlying
 * instrument LAZILY, on the first `.record()` call, via `@opentelemetry/api`'s global meter
 * provider, and stays bound to whatever answered that first call for the lifetime of this test
 * FILE's module registry (Vitest isolates modules per file by default, so this does not leak into
 * other suites). The recording provider below is therefore registered ONCE, at module scope,
 * before any test in this file makes a request — registering it later would be too late for
 * whichever test runs first.
 */

interface RecordedMetric {
  readonly name: string;
  readonly value: number;
  readonly attributes: Attributes | undefined;
}

/** Absorbs timer-vs-`Date.now()` skew on the bounded-probe lower bound below — see that
 * assertion's note. Far below the budget it guards, so the assertion still fails loudly if the
 * race is removed. Mirrors `packages/messaging/test/readiness-probe.test.ts`'s constant of the
 * same name: two bounded probes, two tests, one clock fact. */
const TIMER_SLACK_MS = 50;

const meterRecords: RecordedMetric[] = [];

function noopObservable() {
  return { addCallback: () => undefined, removeCallback: () => undefined };
}

const recordingMeter: Meter = {
  createHistogram: (name): Histogram => ({
    record: (value, attributes) => {
      meterRecords.push({ name, value, attributes });
    },
  }),
  createCounter: (name): Counter => ({
    add: (value, attributes) => {
      meterRecords.push({ name, value, attributes });
    },
  }),
  createUpDownCounter: (): UpDownCounter => ({ add: () => undefined }),
  createGauge: (): Gauge => ({ record: () => undefined }),
  createObservableGauge: noopObservable,
  createObservableCounter: noopObservable,
  createObservableUpDownCounter: noopObservable,
  addBatchObservableCallback: () => undefined,
  removeBatchObservableCallback: () => undefined,
};
const recordingProvider: MeterProvider = { getMeter: () => recordingMeter };
const registered = metrics.setGlobalMeterProvider(recordingProvider);
if (!registered) {
  throw new Error(
    'health-routes.test.ts: a global MeterProvider was already registered — this suite needs to ' +
      "be the first to touch build-app.ts's lazily-resolved httpRequestHistogram in this module registry",
  );
}

/** A worker half that reports everything it checked as ready. `checkedWorkerCount` is non-zero
 * deliberately: an empty missing-list means "all registered" and "watched almost nothing"
 * identically, and only the checked counts tell those apart. */
const HEALTHY_WORKERS = (): Promise<WorkerHealth> =>
  Promise.resolve({
    workersReady: true,
    missingSchedulerIds: [],
    checkedSchedulerIds: ['retention:auth'],
    checkedWorkerCount: 1,
  });

function healthDeps(overrides: Partial<HealthRoutesDependencies> = {}): HealthRoutesDependencies {
  return {
    checkDatabaseReady: () => Promise.resolve(true),
    checkWorkersHealthy: HEALTHY_WORKERS,
    ...overrides,
  };
}

function appWith(health: HealthRoutesDependencies | undefined) {
  return buildApp({
    mode: APP_MODE.Test,
    ...(health === undefined ? {} : { health }),
  });
}

beforeEach(() => {
  meterRecords.length = 0;
});

describe('GET /health', () => {
  it('is 200 { status: "ok" } when the DB probe reports ready', async () => {
    const app = appWith(healthDeps({ checkDatabaseReady: () => Promise.resolve(true) }));
    const response = await app.handle(new Request(`http://localhost${HEALTH_ROUTE_PATH}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: 'ok' });
  });

  it('is 503 when the DB probe reports not ready — the 503 path is reachable via an injected failing probe', async () => {
    const app = appWith(healthDeps({ checkDatabaseReady: () => Promise.resolve(false) }));
    const response = await app.handle(new Request(`http://localhost${HEALTH_ROUTE_PATH}`));
    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({ status: 'unavailable' });
  });

  it('rejects a non-GET method', async () => {
    const app = appWith(healthDeps());
    const response = await app.handle(
      new Request(`http://localhost${HEALTH_ROUTE_PATH}`, { method: 'POST' }),
    );
    expect(response.status).toBe(405);
  });

  it('carries the security header set on both the 200 and the 503 branch', async () => {
    const ok = await appWith(
      healthDeps({ checkDatabaseReady: () => Promise.resolve(true) }),
    ).handle(new Request(`http://localhost${HEALTH_ROUTE_PATH}`));
    const unavailable = await appWith(
      healthDeps({ checkDatabaseReady: () => Promise.resolve(false) }),
    ).handle(new Request(`http://localhost${HEALTH_ROUTE_PATH}`));

    for (const response of [ok, unavailable]) {
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cache-control')).toBe('no-store');
    }
  });

  it('is NOT registered at all when the wiring is absent', async () => {
    const response = await appWith(undefined).handle(
      new Request(`http://localhost${HEALTH_ROUTE_PATH}`),
    );
    expect(response.status).toBe(404);
  });
});

describe('GET /health/worker', () => {
  it('is 200 { status: "ok" } when every worker is ready and no scheduler is missing', async () => {
    const app = appWith(healthDeps({ checkWorkersHealthy: HEALTHY_WORKERS }));
    const response = await app.handle(new Request(`http://localhost${HEALTH_WORKER_ROUTE_PATH}`));
    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ status: 'ok' });
  });

  it('is 503 when workersReady is false — the 503 path is reachable via an injected failing probe', async () => {
    const app = appWith(
      healthDeps({
        checkWorkersHealthy: () =>
          Promise.resolve({
            workersReady: false,
            missingSchedulerIds: [],
            checkedSchedulerIds: ['retention:auth'],
            checkedWorkerCount: 1,
          }),
      }),
    );
    const response = await app.handle(new Request(`http://localhost${HEALTH_WORKER_ROUTE_PATH}`));
    expect(response.status).toBe(503);
    expect(await response.json()).toStrictEqual({ status: 'unavailable' });
  });

  it('is 503 when a scheduler is reported missing, even with every worker ready', async () => {
    const app = appWith(
      healthDeps({
        checkWorkersHealthy: () =>
          Promise.resolve({
            workersReady: true,
            missingSchedulerIds: ['retention:auth'],
            checkedSchedulerIds: ['retention:auth'],
            checkedWorkerCount: 1,
          }),
      }),
    );
    const response = await app.handle(new Request(`http://localhost${HEALTH_WORKER_ROUTE_PATH}`));
    expect(response.status).toBe(503);
  });

  it('rejects a non-GET method', async () => {
    const app = appWith(healthDeps());
    const response = await app.handle(
      new Request(`http://localhost${HEALTH_WORKER_ROUTE_PATH}`, { method: 'POST' }),
    );
    expect(response.status).toBe(405);
  });

  it('is NOT registered at all when the wiring is absent', async () => {
    const response = await appWith(undefined).handle(
      new Request(`http://localhost${HEALTH_WORKER_ROUTE_PATH}`),
    );
    expect(response.status).toBe(404);
  });
});

describe('createDatabaseReadinessProbe', () => {
  it('resolves true when the probe settles within the budget', async () => {
    const probe = createDatabaseReadinessProbe(() => Promise.resolve('ok'));
    await expect(probe()).resolves.toBe(true);
  });

  it('resolves false — never throws — when the probe rejects', async () => {
    const probe = createDatabaseReadinessProbe(() =>
      Promise.reject(new Error('connection refused')),
    );
    await expect(probe()).resolves.toBe(false);
  });

  it(
    'resolves false, bounded to the budget, when the probe never settles',
    async () => {
      const probe = createDatabaseReadinessProbe(() => new Promise(() => undefined));
      const startedAt = Date.now();
      const ready = await probe();
      const elapsedMs = Date.now() - startedAt;

      expect(ready).toBe(false);
      // Slack on the LOWER bound, for the reason `packages/messaging/test/readiness-probe.test.ts`
      // documents at length and this test proved a second time: it was
      // `>= DATABASE_READINESS_BUDGET_MS` exactly and failed on CI with
      // `expected 4999 to be greater than or equal to 5000`. A `setTimeout(…, 5000)` is not
      // guaranteed to be observable as >=5000ms of `Date.now()` delta — the timer may fire a hair
      // early against a coarser clock, and `Date.now()` truncates to whole milliseconds at both
      // ends. Nothing is weakened: with the race removed this resolves in single-digit
      // milliseconds, three orders of magnitude below the floor.
      expect(elapsedMs).toBeGreaterThanOrEqual(DATABASE_READINESS_BUDGET_MS - TIMER_SLACK_MS);
      expect(elapsedMs).toBeLessThan(DATABASE_READINESS_BUDGET_MS + 1_000);
    },
    DATABASE_READINESS_BUDGET_MS + 2_000,
  );
});

describe('neither health route emits an api.http.request datapoint (amendment item 3)', () => {
  it('a real /api/* request DOES record api.http.request (the contrast case, proving the recorder itself works)', async () => {
    const app = appWith(healthDeps());
    await app.handle(new Request('http://localhost/api/nope'));
    expect(meterRecords.some((record) => record.name === 'api.http.request')).toBe(true);
  });

  it('GET /health records ZERO api.http.request datapoints, success or failure', async () => {
    const app = appWith(healthDeps({ checkDatabaseReady: () => Promise.resolve(true) }));
    await app.handle(new Request(`http://localhost${HEALTH_ROUTE_PATH}`));
    await appWith(healthDeps({ checkDatabaseReady: () => Promise.resolve(false) })).handle(
      new Request(`http://localhost${HEALTH_ROUTE_PATH}`),
    );
    expect(meterRecords.filter((record) => record.name === 'api.http.request')).toHaveLength(0);
  });

  it('GET /health/worker records ZERO api.http.request datapoints, success or failure', async () => {
    const app = appWith(healthDeps({ checkWorkersHealthy: HEALTHY_WORKERS }));
    await app.handle(new Request(`http://localhost${HEALTH_WORKER_ROUTE_PATH}`));
    await appWith(
      healthDeps({
        checkWorkersHealthy: () =>
          Promise.resolve({
            workersReady: false,
            missingSchedulerIds: [],
            checkedSchedulerIds: ['retention:auth'],
            checkedWorkerCount: 1,
          }),
      }),
    ).handle(new Request(`http://localhost${HEALTH_WORKER_ROUTE_PATH}`));
    expect(meterRecords.filter((record) => record.name === 'api.http.request')).toHaveLength(0);
  });
});
