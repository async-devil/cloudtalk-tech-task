/**
 * The composition root (ADR-0005, frozen boot order). The only file with import-time side
 * effects — `buildApp` (build-app.ts) stays a pure function of its deps for tests.
 */

import process from 'node:process';
import {
  assertAuthMethodParity,
  assertSessionCookiePolicy,
  createAuth,
  parseAuthMethods,
  startAuthRetention,
} from '@repo/auth';
import {
  APP_MODE,
  ConfigError,
  type ConfigSource,
  composeConfig,
  envFileSource,
  isFailClosed,
  processEnvSource,
  readAppMode,
} from '@repo/config';
import { createSlidingWindowRateLimiter } from '@repo/messaging';
import { createModuleObservability } from '@repo/observability';
import { EXEMPLAR_STRATEGY, initObservability } from '@repo/observability/sdk';
import { createDb } from '@repo/persistence';
import { sql } from 'kysely';
import { APP_CONFIG_SLICES, type AppConfig } from '../config/index.js';
import { createRateLimiters } from '../http/security/rate-limit.js';
import { buildApp } from './build-app.js';
import { createDatabaseReadinessProbe } from './health-routes.js';
import { createPlainTextMailRenderer } from './mail-renderer.js';
import { createDevMailSender } from './mail-sender.js';
import { startReviewsRatingWorker } from './reviews-rating-worker.js';
import { startWorkerLivenessSupervisor } from './worker-liveness.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * The reviews rating-aggregation outbox relay's poll interval (TASK-0005, SPEC-0004 open
 * question 3: "not fixed here — it is the staleness budget... and it belongs with the other
 * operational knobs at the composition root"). SPEC-0001 promises "within seconds"; comfortably
 * under that.
 */
const REVIEWS_RATING_RELAY_INTERVAL_MS = 2_000;
/** Explicit, not `@repo/jobs`'s internal default — `reviews-rating-worker.ts`'s `apply` wrapper
 * must decide "is this the terminal attempt" with the SAME number the relay itself parks at. */
const REVIEWS_RELAY_MAX_ATTEMPTS = 5;
/** `jobs.dead_letter`'s reviews-pipeline triage window — same order of magnitude as auth's own
 * evidence horizons above, for the same reason (long enough for a human to notice and act). */
const REVIEWS_DEAD_LETTER_RETAIN_MS = 30 * DAY_MS;
/** The ADR-0006 floor `REVIEWS_DEAD_LETTER_RETAIN_MS` must exceed — see
 * `reviews-rating-worker.ts`'s own doc on why this pipeline has no real in-flight window to
 * protect. */
const REVIEWS_DEAD_LETTER_STALE_AFTER_MS = 5 * 60 * 1000;

/**
 * How much headroom the SOCKET-level body ceiling gets over the app-level
 * `HTTP_BODY_LIMIT_BYTES` (see the `listen` call's note). Big enough that ordinary over-cap
 * requests still reach `enforceBodyCap` and receive the uniform typed 413 rather than Bun's
 * bodyless one; small enough that the runtime's worst-case per-request buffering is single-digit
 * MB instead of Bun's 128MB default.
 */
const SOCKET_BODY_CEILING_FACTOR = 8;

async function main(): Promise<void> {
  // 1. mode — the one sanctioned `process.env` touchpoint outside @repo/config.
  const mode = readAppMode(process.env);

  // 2. compose config: [api, observability, persistence, messaging, auth]. Precedence (later
  // source wins): env-file (test only) -> process env, always last.
  const sources: ConfigSource[] = [
    ...(mode === APP_MODE.Test ? [envFileSource('.env')] : []),
    processEnvSource(process.env),
  ];

  const { config, report } = await composeConfig<AppConfig>({
    mode,
    slices: APP_CONFIG_SLICES,
    sources,
  });

  // 3. initObservability — first construction of anything. `mode === 'test'` wires no network
  // exporters: the composed config still defaults an OTLP endpoint for local convenience, so the
  // composition root — not the SDK — is what withholds it in test mode. staging/production pass
  // the endpoint and export for real.
  const observability = initObservability({
    mode,
    serviceName: config.observability.OTEL_SERVICE_NAME,
    serviceVersion: '0.0.0',
    serviceNamespace: config.observability.OTEL_SERVICE_NAMESPACE,
    deploymentEnvironment: config.observability.DEPLOYMENT_ENVIRONMENT,
    logLevel: config.observability.LOG_LEVEL,
    // Metrics→traces via the collector spanmetrics connector (ADR-0009); swaps to
    // EXEMPLAR_STRATEGY.SdkNative when @opentelemetry/sdk-metrics can emit exemplars.
    exemplarStrategy: EXEMPLAR_STRATEGY.CollectorSpanmetrics,
    ...(mode === APP_MODE.Test
      ? {}
      : { otlpEndpoint: config.observability.OTEL_EXPORTER_OTLP_ENDPOINT }),
  });

  const obs = createModuleObservability('api');

  // 4. log the config report (key names + sources, never values).
  obs.logger.info({ report }, 'api.boot.config: composed');

  // 5. createDb (app pool). Boot never auto-migrates — `moon run api:migrate` is separate.
  const db = createDb<unknown>({
    connectionString: config.persistence.DATABASE_URL,
    poolSize: config.persistence.DATABASE_POOL_SIZE,
    applicationName: config.observability.OTEL_SERVICE_NAME,
  });

  // 6. auth (ADR-0013). The mail renderer and mail sender are this app's own adapters
  // (`runtime/mail-renderer.ts`, `runtime/mail-sender.ts`) — the ONE thing this composition root
  // must build itself rather than consume from a mailing module, since this repository carries
  // none. `createDevMailSender` REFUSES to construct in a fail-closed tier: it only logs, and
  // ADR-0013 records that limitation plainly rather than shipping a sender that silently cannot
  // deliver mail in a real deployment. `createAuth` builds the better-auth instance from
  // `config.auth`, then `assertAuthMethodParity` fails boot if what it mounted differs from the
  // claimed methods, and `createSessionMiddleware`/`resolveRequestSession` derive the
  // server-authoritative session at the HTTP boundary (`http/index.ts`).
  const mailSender = createDevMailSender(mode);
  const mailRenderer = createPlainTextMailRenderer();
  // The per-recipient-address magic-link bucket (ADR-0013). Constructed here (the composition
  // root owns the Redis connection + the api-slice config value) and injected through
  // `AuthDependencies` — the address only exists inside auth's send hook, never in HTTP
  // middleware, so auth consumes this limiter rather than the HTTP layer enforcing it.
  const magicLinkRateLimiter = createSlidingWindowRateLimiter({
    connection: { redisUrl: config.messaging.REDIS_URL },
    bucketKeyPrefix: 'rate-limit:auth:magic-link-address',
    limit: config.api.RATE_LIMIT_MAGIC_LINK_PER_ADDRESS_PER_HOUR,
    windowMs: HOUR_MS,
  });
  // ONE declaration of "which browser origins are this product's own front end", read here and
  // handed to both consumers below. The CORS allow-list decides whether the browser is ALLOWED to
  // make the call; better-auth's `trustedOrigins` decides whether the auth routes ACCEPT it.
  // Splitting them into two config keys would let a deployment satisfy one and fail the other,
  // and the symptom — sign-in 403s while every other route works — points at neither.
  const spaOrigins = config.api.HTTP_CORS_ALLOWED_ORIGINS.split(',').map((origin) => origin.trim());
  const authHandle = createAuth({
    db,
    mailSender,
    mailRenderer,
    config: config.auth,
    magicLinkRateLimiter,
    trustedOrigins: spaOrigins,
  });
  const parsedAuthMethods = parseAuthMethods(config.auth.AUTH_METHODS);
  assertAuthMethodParity(authHandle, parsedAuthMethods.ok ? parsedAuthMethods.methods : []);
  // Cookie-posture drift check: the built instance's session-cookie attributes must match the
  // frozen pin; Secure tracks AUTH_BASE_URL's scheme (https in fail-closed tiers, http on
  // localhost dev). Boot fails here rather than shipping a weak cookie.
  assertSessionCookiePolicy(authHandle, {
    expectSecure: config.auth.AUTH_BASE_URL.startsWith('https://'),
  });
  // The session middleware's framework-agnostic core (`resolveRequestSession`) is wired
  // route-level below (step 8, `session:` on `buildApp`'s deps) rather than as an Elysia plugin:
  // the mounted oRPC routes bypass Elysia's derive chain, so there is nothing for a plugin to
  // enrich here (see build-app.ts's header note).

  // 7. startAuthRetention: the retention pattern applied to auth's own evidence tables. Guidance
  // horizons: sessions 30d past expiry, verifications 7d; the composition root owns the numbers.
  // `db` is typed `Kysely<unknown>` (step 5) precisely so auth and auth retention — which own raw
  // SQL against their own schema, not any table this app defines — can take it directly, with no
  // generated `DB` type or cast in between.
  const authRetention = await startAuthRetention({
    db,
    sessionRetainMs: 30 * DAY_MS,
    verificationRetainMs: 7 * DAY_MS,
    connection: { redisUrl: config.messaging.REDIS_URL },
    everyMs: HOUR_MS,
  });

  // 7b. the two HTTP-layer sliding-window limiters (Auth/UnauthenticatedPost) — a sibling
  // connection to retention's, same Redis.
  const rateLimiters = createRateLimiters({
    connection: { redisUrl: config.messaging.REDIS_URL },
    config: {
      authPerMinute: config.api.RATE_LIMIT_AUTH_PER_MINUTE,
      unauthenticatedPostPerMinute: config.api.RATE_LIMIT_UNAUTHENTICATED_POST_PER_MINUTE,
      trustProxy: config.api.HTTP_TRUST_PROXY,
    },
  });

  // 7c. reviews rating-aggregation outbox relay (TASK-0005, SPEC-0004, ADR-0007, ADR-0014): the
  // first in-process background worker this composition root runs, so this is also the moment
  // `checkWorkersHealthy`/the worker-liveness supervisor (below, step 9) start being wired at all
  // — `health-routes.ts`'s and `worker-liveness.ts`'s own header comments both named this as the
  // trigger. `everyMs`/the two dead-letter horizons are composition-root knobs, same precedent as
  // step 7's `sessionRetainMs`/`verificationRetainMs`: guidance numbers owned here, not a config
  // slice (SPEC-0004 open question 3 explicitly leaves the relay interval to this root).
  const reviewsRatingWorker = await startReviewsRatingWorker({
    db,
    connection: { redisUrl: config.messaging.REDIS_URL },
    relayEveryMs: REVIEWS_RATING_RELAY_INTERVAL_MS,
    relayMaxAttempts: REVIEWS_RELAY_MAX_ATTEMPTS,
    deadLetterRetainMs: REVIEWS_DEAD_LETTER_RETAIN_MS,
    deadLetterStaleAfterMs: REVIEWS_DEAD_LETTER_STALE_AFTER_MS,
    deadLetterRetentionEveryMs: HOUR_MS,
  });

  // 8. buildApp -> listen. `session`: every session-scoped route resolves its session per-request
  // from this same auth instance's `api` + the owner db. `mode`/`cors`/`bodyCap`/`rateLimiters`
  // wire the ADR-0013 security baseline.
  const app = buildApp({
    auth: { handler: authHandle.handler },
    session: { api: authHandle.api, db },
    mode,
    rateLimiters,
    cors: { allowedOrigins: spaOrigins },
    bodyCap: { limitBytes: config.api.HTTP_BODY_LIMIT_BYTES },
    // `GET /health` round-trips a `SELECT 1` against this app's own pool. `GET /health/worker`
    // reads the reviews rating worker's own combined probe (step 7c) — this composition root's
    // first (and so far only) in-process background worker pipeline.
    health: {
      checkDatabaseReady: createDatabaseReadinessProbe(() => sql`SELECT 1`.execute(db)),
      checkWorkersHealthy: reviewsRatingWorker.checkHealth,
    },
    // The e2e session-mock, `test` mode ONLY — the conditional spread is the structure (a
    // fail-closed tier hands `buildApp` no `sessionMock` at all, so there is nothing for it to
    // register even if its own mode check were removed). `mailSender` only ever constructs
    // successfully in `test` mode (see step 6), so reading its capture here is safe.
    ...(mode === APP_MODE.Test
      ? {
          sessionMock: {
            authHandler: authHandle.handler,
            authBaseUrl: config.auth.AUTH_BASE_URL,
            readLastSentMailTextFor: mailSender.readLastSentTextFor,
          },
        }
      : {}),
  });
  app.listen({
    port: config.api.PORT,
    hostname: config.api.HOST,
    /**
     * Socket-layer body ceiling. `enforceBodyCap` is an APPLICATION-layer check: by the time it
     * runs, the runtime has already accepted the bytes. Bun's default here is 128MB, so against
     * the 1MB `HTTP_BODY_LIMIT_BYTES` default an attacker could make the process hold ~128MB per
     * in-flight request before our cap ever rejected it.
     *
     * Deliberately the limit TIMES {@link SOCKET_BODY_CEILING_FACTOR}, not the limit itself.
     * Bun's own socket-level rejection is a bare 413 with an EMPTY body, which would violate the
     * uniform "413 with the wire shape" contract for every ordinary just-over-the-limit request.
     * The headroom keeps normal over-cap traffic flowing to `enforceBodyCap`, which answers with
     * the typed shape, while still cutting the runtime's worst-case buffering from 128MB to
     * single-digit MB per request.
     *
     * KNOWN GAP, recorded rather than papered over: this bounds bodies that DECLARE a
     * `Content-Length`. A chunked body declaring none is still streamed in, and every
     * handler-side strategy measured (drain / cancel / bounded-drain) either balloons RSS or
     * hangs the client — the memory is the runtime's inbound buffering, not our loop. Cutting
     * those off belongs at the edge, in front of this process.
     */
    maxRequestBodySize: config.api.HTTP_BODY_LIMIT_BYTES * SOCKET_BODY_CEILING_FACTOR,
  });
  obs.logger.info({ port: config.api.PORT, host: config.api.HOST }, 'api.boot.listen: ready');

  // 9. worker-liveness supervisor (`worker-liveness.ts`): fail-closed tiers only — `test` mode
  // must never have the process exit itself out from under the suite (that file's own "SCOPE"
  // note). This is the first in-process worker the composition root has ever started, which is
  // exactly the moment that file's header names as the trigger for wiring it.
  const workerLivenessSupervisor = isFailClosed(mode)
    ? startWorkerLivenessSupervisor({
        checkHealth: reviewsRatingWorker.checkHealth,
        onUnrecoverable: (failure) => {
          obs.logger.error(
            { failure },
            'api.worker-liveness: worker half unhealthy past the grace window — exiting so the ' +
              'process supervisor restarts it',
          );
          process.exit(1);
        },
        log: (event) => {
          if (event.kind === 'unhealthy') {
            obs.logger.warn({ health: event.health }, 'api.worker-liveness: worker half unhealthy');
          } else if (event.kind === 'recovered') {
            obs.logger.info(
              { unhealthyForMs: event.unhealthyForMs },
              'api.worker-liveness: worker half recovered',
            );
          }
        },
      })
    : undefined;

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    obs.logger.info({ signal }, 'api.boot.shutdown: closing');

    workerLivenessSupervisor?.close();
    await app.stop();

    // `authRetention.close()`/`reviewsRatingWorker.close()` BEFORE `db.destroy()`: both hold a
    // Redis connection and may still be touching the db pool during their own graceful shutdown —
    // destroying the db pool first would break that.
    await authRetention.close();
    await reviewsRatingWorker.close();
    await rateLimiters.close();
    await magicLinkRateLimiter.close();

    await db.destroy();
    await observability.shutdown();
    process.exit(0);
  }

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
}

main().catch((error: unknown) => {
  // Fail-closed config report: every issue, key names only, to stderr — then a non-zero exit.
  if (error instanceof ConfigError) {
    for (const issue of error.issues) {
      process.stderr.write(`api: config: ${issue.key}: ${issue.message}\n`);
    }
  } else {
    process.stderr.write(`api: ${String(error)}\n`);
  }
  process.exit(1);
});
