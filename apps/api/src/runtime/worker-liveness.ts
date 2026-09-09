/**
 * Worker-liveness supervisor: turns "permanently worker-dead" into "restarted".
 *
 * THE FAILURE THIS EXISTS FOR, observed rather than imagined against a BullMQ-backed worker under
 * a rapid container recreate: a bun Redis client can throw an invalid-response error during
 * reconnect. The error surfaces asynchronously, before the composition root logs "ready", and
 * does not kill the process — what breaks is a worker's connection, not the boot itself.
 * `isReady()` then stays false forever: the HTTP server serves, `/health` (Postgres only) is
 * green, `/health/worker` correctly 503s, and nothing ever changes.
 *
 * That state is worse than a crash. A crash at least exits, and `restart: unless-stopped`
 * recovers it; this one degrades quietly and forever. Docker cannot help either — a failing
 * `healthcheck` marks a container unhealthy and does not restart it (that is Swarm/Kubernetes
 * behaviour, not compose's). So the process has to notice its own worker half is gone and exit,
 * which is what this does.
 *
 * WHY A GRACE WINDOW RATHER THAN A SINGLE FAILED PROBE. A Redis blip, a failover, or a few
 * seconds of network loss all make `checkHealth()` unhappy and all recover on their own; exiting
 * on the first bad probe would turn every blip into a restart. The supervisor exits only after
 * the worker half has been CONTINUOUSLY unhealthy for {@link WORKER_UNHEALTHY_GRACE_MS} — one
 * healthy probe resets the clock completely.
 *
 * WHY IT IS NOT A HEALTHCHECK. A deploy-time gate can already probe both endpoints and catch a
 * dead-on-arrival worker before traffic ever reaches it; the gap this closes is steady state,
 * after a deploy has gone green. This runs in-process for the life of the process, which is the
 * only place that gap is visible.
 *
 * SCOPE: the composition root wires this in fail-closed tiers only (`main.ts`). In `test` mode a
 * process that exits itself would take the suite with it, and a developer's Redis being down is
 * not an incident.
 *
 * This app currently wires no background worker pipeline of its own, so `main.ts` does not start
 * this supervisor today — it is carried as the reusable mechanism a future in-process worker
 * (jobs-spine consumers, `@repo/jobs`) wires the moment one exists, rather than something that
 * gets re-derived from scratch then.
 */

/** The shape a worker-owning composition root reports through `checkHealth` — deliberately
 * decoupled from any one pipeline's own health type, so this supervisor (and `/health/worker`,
 * `health-routes.ts`) can watch whatever background workers a composition root eventually starts. */
export interface WorkerHealth {
  /** Every directly-owned worker this probe checked reported ready. */
  readonly workersReady: boolean;
  /** Repeatable-schedule ids expected in Redis but not found there. Checked alongside
   * `workersReady` rather than folded into it: an empty array here is only meaningful together
   * with a non-empty `checkedSchedulerIds` below — otherwise "nothing missing" and "nothing
   * checked" are indistinguishable. */
  readonly missingSchedulerIds: readonly string[];
  /** The scheduler ids this probe actually checked — see `missingSchedulerIds`'s note. */
  readonly checkedSchedulerIds?: readonly string[];
  /** How many workers `workersReady` actually asked. */
  readonly checkedWorkerCount: number;
}

/**
 * How long the worker half must be CONTINUOUSLY unhealthy before the process gives up on itself.
 *
 * Sized against the two deadlines around it rather than picked: comfortably longer than a
 * `@repo/messaging` readiness probe (2s) plus the slack a reconnect needs, and short enough that
 * a deploy's own health gate still has room for the restart AND the fresh boot to go green —
 * which is what makes this fix a deploy flake rather than merely survive it.
 */
export const WORKER_UNHEALTHY_GRACE_MS = 30_000;

/** How often the worker half is probed. Cheap: the probe is the same bounded seam `/health/worker`
 * calls, and on a healthy pipeline it answers in single-digit milliseconds. */
export const WORKER_PROBE_INTERVAL_MS = 5_000;

export interface WorkerLivenessSupervisorDependencies {
  /** The same seam `/health/worker` reads. */
  readonly checkHealth: () => Promise<WorkerHealth>;
  /**
   * Called ONCE, when the worker half has been unhealthy for the whole grace window. The
   * composition root passes the process exit; tests pass a spy. Never called again afterwards —
   * a supervisor that keeps firing during a slow shutdown is noise at best.
   */
  readonly onUnrecoverable: (detail: WorkerLivenessFailure) => void;
  /** Structured log for every transition (healthy → unhealthy and back), so an operator reading
   * logs can see how long the window was open before a restart. */
  readonly log: (event: WorkerLivenessEvent) => void;
  /** Injected for tests; defaults to the real clock and timer. */
  readonly now?: () => number;
  readonly setIntervalFn?: typeof setInterval;
  readonly clearIntervalFn?: typeof clearInterval;
  readonly graceMs?: number;
  readonly intervalMs?: number;
}

export interface WorkerLivenessFailure {
  readonly unhealthyForMs: number;
  readonly workersReady: boolean;
  readonly missingSchedulerIds: readonly string[];
  readonly checkedWorkerCount: number;
}

export type WorkerLivenessEvent =
  | { readonly kind: 'unhealthy'; readonly health: WorkerHealth }
  | { readonly kind: 'recovered'; readonly unhealthyForMs: number }
  | { readonly kind: 'giving-up'; readonly failure: WorkerLivenessFailure };

/** The `/health/worker` predicate, in one place so the supervisor and the route can never drift
 * on what "the worker half is up" means. */
export function isWorkerHalfHealthy(health: WorkerHealth): boolean {
  return health.workersReady && health.missingSchedulerIds.length === 0;
}

export interface WorkerLivenessSupervisor {
  /** Stops probing. Idempotent — the shutdown path may call it after `onUnrecoverable` fired. */
  close(): void;
}

/**
 * Starts probing. Returns immediately; the first probe happens one interval later, so a caller
 * that has just awaited its own workers' startup is never judged before they have connected.
 */
export function startWorkerLivenessSupervisor(
  deps: WorkerLivenessSupervisorDependencies,
): WorkerLivenessSupervisor {
  const now = deps.now ?? Date.now;
  const setIntervalImpl = deps.setIntervalFn ?? setInterval;
  const clearIntervalImpl = deps.clearIntervalFn ?? clearInterval;
  const graceMs = deps.graceMs ?? WORKER_UNHEALTHY_GRACE_MS;
  const intervalMs = deps.intervalMs ?? WORKER_PROBE_INTERVAL_MS;

  /** When the CURRENT continuous unhealthy stretch began; `undefined` while healthy. */
  let unhealthySince: number | undefined;
  let givenUp = false;
  let probing = false;

  async function probe(): Promise<void> {
    // A probe that overruns the interval must not stack: `checkHealth` is bounded (one readiness
    // deadline) but that bound is 2s against a 5s interval, and a stalled Redis is exactly when
    // this runs. Skipping keeps the unhealthy clock honest — it measures wall time, not probes.
    if (probing || givenUp) {
      return;
    }
    probing = true;
    try {
      // `checkHealth` is documented as never throwing; treated as unhealthy rather than trusted,
      // because a supervisor that dies on its own probe is the thing it exists to prevent.
      let health: WorkerHealth;
      try {
        health = await deps.checkHealth();
      } catch {
        health = { workersReady: false, missingSchedulerIds: [], checkedWorkerCount: 0 };
      }

      if (isWorkerHalfHealthy(health)) {
        if (unhealthySince !== undefined) {
          deps.log({ kind: 'recovered', unhealthyForMs: now() - unhealthySince });
          unhealthySince = undefined;
        }
        return;
      }

      if (unhealthySince === undefined) {
        unhealthySince = now();
        deps.log({ kind: 'unhealthy', health });
        return;
      }

      const unhealthyForMs = now() - unhealthySince;
      if (unhealthyForMs >= graceMs) {
        givenUp = true;
        const failure: WorkerLivenessFailure = {
          unhealthyForMs,
          workersReady: health.workersReady,
          missingSchedulerIds: health.missingSchedulerIds,
          checkedWorkerCount: health.checkedWorkerCount,
        };
        deps.log({ kind: 'giving-up', failure });
        deps.onUnrecoverable(failure);
      }
    } finally {
      probing = false;
    }
  }

  const timer = setIntervalImpl(() => {
    void probe();
  }, intervalMs);
  // Never hold the process open on the supervisor's account: if everything else has finished,
  // this timer must not be the reason the runtime stays alive.
  (timer as { unref?: () => void }).unref?.();

  return {
    close(): void {
      clearIntervalImpl(timer);
    },
  };
}
