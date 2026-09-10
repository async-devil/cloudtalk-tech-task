import { defineConfigSlice, isFailClosed } from '@repo/config';
import { z } from 'zod';

/** The dev SPA's default Vite origin (`test`-tier only default — a live tier always requires
 * `HTTP_CORS_ALLOWED_ORIGINS` explicitly). */
const DEV_SPA_ORIGIN = 'http://localhost:5173';

/**
 * The app-local `api` config slice, frozen keys:
 *
 * | env key | required | default (non-live) |
 * |---|---|---|
 * | `PORT` | no | `3000` |
 * | `HOST` | no | `0.0.0.0` |
 * | `RATE_LIMIT_AUTH_PER_MINUTE` | no | `10` fail-closed / `1000` test |
 * | `RATE_LIMIT_UNAUTHENTICATED_POST_PER_MINUTE` | no | `30` fail-closed / `3000` test |
 * | `RATE_LIMIT_ANONYMOUS_READ_PER_MINUTE` | no | `120` fail-closed / `12000` test (ADR-0019) |
 * | `RATE_LIMIT_REVIEW_SUBMISSION_PER_MINUTE` | no | `10` fail-closed / `1000` test (ADR-0019) |
 * | `RATE_LIMIT_MAGIC_LINK_PER_ADDRESS_PER_HOUR` | no | `5` fail-closed / `500` test |
 * | `HTTP_TRUST_PROXY` | no | `false` |
 * | `HTTP_BODY_LIMIT_BYTES` | no | `1048576` |
 * | `HTTP_CORS_ALLOWED_ORIGINS` | staging/production | dev SPA origin |
 *
 * ADR-0013's security baseline: dev-mode loosening of the rate-limit defaults is always HIGHER
 * limits (100x the fail-closed default in the test tier), never a disabled limiter.
 */
export const apiConfigSlice = defineConfigSlice('api', (mode) =>
  z
    .object({
      PORT: z.coerce.number().int().min(1).max(65_535).default(3000).describe('API listen port.'),
      HOST: z.string().min(1).default('0.0.0.0').describe('API bind address.'),
      RATE_LIMIT_AUTH_PER_MINUTE: z.coerce
        .number()
        .int()
        .min(1)
        .default(isFailClosed(mode) ? 10 : 1_000)
        .describe(
          'Per-IP ceiling for /api/auth/* requests. Dev-mode loosening is higher limits, ' +
            'never a disabled limiter (100x the fail-closed default in the test tier).',
        ),
      RATE_LIMIT_UNAUTHENTICATED_POST_PER_MINUTE: z.coerce
        .number()
        .int()
        .min(1)
        .default(isFailClosed(mode) ? 30 : 3_000)
        .describe('Per-IP ceiling for a POST with no resolved session.'),
      RATE_LIMIT_ANONYMOUS_READ_PER_MINUTE: z.coerce
        .number()
        .int()
        .min(1)
        .default(isFailClosed(mode) ? 120 : 12_000)
        .describe(
          'Per-IP ceiling for a GET with no resolved session (ADR-0019) — every anonymous ' +
            'catalogue/product/review-list read.',
        ),
      RATE_LIMIT_REVIEW_SUBMISSION_PER_MINUTE: z.coerce
        .number()
        .int()
        .min(1)
        .default(isFailClosed(mode) ? 10 : 1_000)
        .describe(
          'Per-user ceiling for reviews.submit/reviews.update with a resolved session ' +
            '(ADR-0019), keyed by the internal user id rather than client IP.',
        ),
      RATE_LIMIT_MAGIC_LINK_PER_ADDRESS_PER_HOUR: z.coerce
        .number()
        .int()
        .min(1)
        .default(isFailClosed(mode) ? 5 : 500)
        .describe(
          'Per-recipient-address magic-link send ceiling — bounds one IP directing unlimited ' +
            "magic-link emails at a single victim address. Enforced inside packages/auth's send " +
            'hook (the address only exists there), via a limiter this app constructs and injects ' +
            'through AuthDependencies.',
        ),
      /**
       * `z.stringbool()`, NOT `z.coerce.boolean()`.
       *
       * Config values arrive as env STRINGS, and `z.coerce.boolean()` is JS `Boolean(...)`: every
       * non-empty string is `true`, so `HTTP_TRUST_PROXY=false` would parse to **true** and the
       * app would trust `X-Forwarded-For` from direct connections — a spoofable client IP, and the
       * exact inversion of what the operator wrote. `z.stringbool()` maps the
       * "false"/"0"/"no"/"off" family to `false`, the "true" family to `true`, and REJECTS
       * anything else rather than silently choosing a side.
       */
      HTTP_TRUST_PROXY: z
        .stringbool()
        .default(false)
        .describe(
          "When true, client IP is read from X-Forwarded-For's first hop. Default false: " +
            'trusting the header without a real reverse proxy in front is spoofable. Required ' +
            'true in fail-closed tiers (see the superRefine below).',
        ),
      HTTP_BODY_LIMIT_BYTES: z.coerce
        .number()
        .int()
        .min(1)
        .default(1_048_576)
        .describe('JSON bodies over this size are rejected 413.'),
      HTTP_CORS_ALLOWED_ORIGINS: (isFailClosed(mode)
        ? z.string().min(1)
        : z.string().min(1).default(DEV_SPA_ORIGIN)
      ).describe(
        'Live-required. Comma-separated EXACT origins credentialed CORS reflects. No wildcard ' +
          'with credentials, ever — structurally unconstructible (http/security/cors.ts).',
      ),
    })
    /**
     * The proxy dependency made structural, not merely documented.
     *
     * This app's `.mount()`-based routing exposes no socket-derived client IP, so
     * `X-Forwarded-For` is the ONLY source of a per-client subject key, and it is read only when
     * `HTTP_TRUST_PROXY` is true. With the flag false, every direct client collapses onto one
     * shared bucket: the per-IP ceiling silently becomes a GLOBAL one, and any single client can
     * exhaust it for everyone. That is a denial-of-service amplifier, not the rate limiting
     * ADR-0013 requires — so a fail-closed tier must not boot into it silently.
     *
     * A control that depends on someone remembering to wire something becomes a boot failure
     * rather than a silent hole. Setting the flag true behind a real reverse proxy, or explicitly
     * accepting a coarse global bucket, both remain available — but as a decision, made visibly in
     * config review.
     *
     * `test` tier is unaffected: it has no proxy and wants none.
     */
    .superRefine((value, ctx) => {
      if (isFailClosed(mode) && value.HTTP_TRUST_PROXY !== true) {
        ctx.addIssue({
          code: 'custom',
          path: ['HTTP_TRUST_PROXY'],
          message:
            'HTTP_TRUST_PROXY must be true in a fail-closed tier: without a trusted proxy this ' +
            'app has no per-client IP, so every RATE_LIMIT_* per-IP ceiling degrades to a single ' +
            'global bucket one client can exhaust for everyone. Set it true behind a reverse ' +
            'proxy, or run a tier that does not fail closed.',
        });
      }
    }),
);

/** The parsed output of {@link apiConfigSlice}: `AppConfig` composes from this exported type
 * rather than restating the field list by hand. */
export type ApiSliceConfig = z.infer<ReturnType<typeof apiConfigSlice.schema>>;
