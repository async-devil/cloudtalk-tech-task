import {
  MAIL_TEMPLATE,
  type MailMessage,
  type MailRendererPort,
  type MailSenderPort,
} from '@repo/contracts';
import { mintToken, TOKEN_PREFIX } from '@repo/entities';
import { ERROR_CODE, isAppError } from '@repo/kernel';
import type { SlidingWindowRateLimiter } from '@repo/messaging';
import { rowAs } from '@repo/persistence';
import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { magicLink } from 'better-auth/plugins';
import { type Kysely, sql } from 'kysely';
import { type AuthSliceConfig, parseAuthMethods } from './config-slice.js';
import { MagicLinkSendFailedError } from './errors.js';
import {
  AUTH_OUTCOME,
  observability,
  requestCounter,
  routeGroupOf,
} from './internal/observability.js';
import { appUserRowSchema } from './internal/rows.js';
import { AUTH_METHOD, type AuthMethod } from './methods.js';
import { assertSignupAllowed, parseSignupAllowedEmails } from './signup-posture.js';

/**
 * The minimal better-auth server-API surface the session middleware needs — the ONE place a
 * better-auth type is narrowed for re-export, so nothing but this shape leaves the package.
 * better-auth is held at arm's length (ADR-0013), and `auth.api` is cast to this at the boundary
 * below.
 */
export interface AuthApi {
  getSession(input: { readonly headers: Headers }): Promise<{
    readonly session: { readonly userId: string };
    readonly user: { readonly id: string; readonly email: string };
  } | null>;
}

/**
 * Dependencies for {@link createAuth}. This module PRODUCES template data and consumes ports; it
 * holds no concrete renderer or sender of its own, because rendering and sending mail is another
 * module's bounded context (ADR-0001). The composition root supplies both (ADR-0005).
 */
export interface AuthDependencies {
  readonly db: Kysely<unknown>;
  readonly mailSender: MailSenderPort;
  readonly mailRenderer: MailRendererPort;
  readonly config: AuthSliceConfig;
  /**
   * The per-recipient-address magic-link send bucket (ADR-0013). The address only exists inside
   * this module's send hook — never at the HTTP middleware, which sees an IP — so the limiter is
   * injected here rather than built inline: the composition root owns the Redis connection and the
   * ceiling, the same "auth consumes a port, never constructs an adapter" shape `mailRenderer` and
   * `mailSender` already set.
   */
  readonly magicLinkRateLimiter: SlidingWindowRateLimiter;
  /**
   * The browser origins allowed to drive the auth routes — this product's own front ends.
   *
   * WITHOUT THIS THE SPA CANNOT SIGN IN AT ALL, which is why it is required rather than optional.
   * better-auth defaults `trustedOrigins` to `[baseURL]` — the API's own origin — and its
   * `originCheck` middleware then rejects the SPA's `POST /api/auth/sign-in/magic-link` with 403
   * as soon as it carries a `callbackURL` pointing back at the app. The SPA is a different origin
   * in every environment (`:5173` in dev, `:4173` under `vite preview`, its own domain in
   * production), so the default is wrong everywhere except for a server-side caller. Read from
   * better-auth 1.6.23's own `dist/api/middlewares/origin-check.mjs`, not inferred.
   *
   * Composition roots pass the SAME list they give the CORS allow-list: "origins the browser may
   * call us from" and "origins we trust to be our own front end" are one fact, and two lists that
   * must agree is two lists that will not. The base URL is added by the factory, so a caller never
   * has to remember it.
   */
  readonly trustedOrigins: readonly string[];
}

/** The session-cookie attributes the factory pins. Exposed on {@link AuthHandle} so
 * `assertSessionCookiePolicy` can verify at boot that the built instance carries them. */
export interface SessionCookieAttributes {
  readonly httpOnly: boolean;
  readonly sameSite: 'lax' | 'strict' | 'none';
  readonly path: string;
  readonly secure: boolean;
}

/** What the composition root mounts and the session middleware reads. */
export interface AuthHandle {
  /** The better-auth instance's fetch handler, wrapped to record `auth.request.handle`. */
  readonly handler: (request: Request) => Promise<Response>;
  /** better-auth's server API surface, narrowed to {@link AuthApi}. */
  readonly api: AuthApi;
  /**
   * The methods better-auth ACTUALLY mounted, derived from the instance's endpoint registry and
   * resolved options. `assertAuthMethodParity` compares this to the claimed `config.methods` —
   * reading the real instance is what makes the check a drift killer rather than a restatement of
   * the config it is supposed to be checking.
   */
  readonly mountedMethods: readonly AuthMethod[];
  /** The session-cookie attributes this instance was configured with. The boot-time
   * `assertSessionCookiePolicy` checks these against the pin — the cookie half of the drift
   * check. */
  readonly sessionCookieAttributes: SessionCookieAttributes;
}

/** Reads the mounted method set from a live better-auth instance: magic-link is a mounted ENDPOINT
 * (`/sign-in/magic-link`), while password and the OAuth providers are resolved OPTIONS (social
 * providers share one `/sign-in/social` endpoint, so the provider identity exists only in
 * options). A structured surface, never route-string guessing at the config level. */
function deriveMountedMethods(instance: {
  readonly api: Record<string, unknown>;
  readonly options: {
    readonly emailAndPassword?: { readonly enabled?: boolean };
    readonly socialProviders?: Record<string, unknown>;
  };
}): readonly AuthMethod[] {
  const paths = Object.values(instance.api)
    .map((endpoint) =>
      // better-auth endpoints are callable FUNCTIONS carrying a `.path` property, not plain
      // objects — accept both, or the magic-link endpoint is never seen.
      endpoint !== null &&
      (typeof endpoint === 'object' || typeof endpoint === 'function') &&
      'path' in endpoint
        ? String((endpoint as { path: unknown }).path)
        : '',
    )
    .filter((path) => path.length > 0);
  const mounted = new Set<AuthMethod>();
  if (paths.some((path) => path.includes('/sign-in/magic-link'))) {
    mounted.add(AUTH_METHOD.MagicLink);
  }
  if (instance.options.emailAndPassword?.enabled === true) {
    mounted.add(AUTH_METHOD.Password);
  }
  const providers = Object.keys(instance.options.socialProviders ?? {});
  if (providers.includes('google')) {
    mounted.add(AUTH_METHOD.GoogleOAuth);
  }
  if (providers.includes('github')) {
    mounted.add(AUTH_METHOD.GitHubOAuth);
  }
  return [...mounted];
}

/**
 * Builds the better-auth instance from `config.methods`.
 *
 * Pinned behaviours: a method absent from the config is **not configured at all** — an absent
 * plugin is not the same as a disabled flag, because the server cannot serve a flow it never
 * mounted. Password auth, when enabled, sets `requireEmailVerification` (ADR-0013,
 * non-negotiable). Session cookies are `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` in
 * fail-closed tiers — derived from the base URL's scheme, which is https there and http on
 * localhost. `advanced.database.generateId: 'uuid'` makes the database's own `uuidv7()` default
 * mint every id.
 */
export function createAuth(deps: AuthDependencies): AuthHandle {
  const parsed = parseAuthMethods(deps.config.AUTH_METHODS);
  // The slice's superRefine already rejected an invalid or empty list at boot; this guard keeps
  // the function total without an unchecked assertion.
  const methods: readonly AuthMethod[] = parsed.ok ? parsed.methods : [];
  const useSecureCookies = deps.config.AUTH_BASE_URL.startsWith('https://');
  // Pinned, not configurable, and named so it rides onto the handle for the boot-time
  // `assertSessionCookiePolicy` drift check. `SameSite=None` is unconstructible here by design.
  const sessionCookieAttributes: SessionCookieAttributes = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: useSecureCookies,
  };

  async function ensureAppUser(identityId: string): Promise<string> {
    // Replay-safe: the hook may run more than once for an identity, and a second run is a no-op
    // INSERT plus a re-read, never a duplicate row (uq_app_user__identity_id).
    await sql`
      INSERT INTO auth.app_user (identity_id, token)
      VALUES (${identityId}::uuid, ${mintToken(TOKEN_PREFIX.User)})
      ON CONFLICT (identity_id) DO NOTHING
    `.execute(deps.db);
    // Selects every column `appUserRowSchema` requires, not just the one this function returns —
    // `rowAs` parses the whole row, so a narrower select here fails every sign-in with a schema
    // error (found while verifying TASK-0006's seeded accounts against a real Postgres).
    const result = await sql`
      SELECT app_user_id, token, catalogue_manager, moderator FROM auth.app_user
      WHERE identity_id = ${identityId}::uuid
    `.execute(deps.db);
    return rowAs(appUserRowSchema, result.rows[0]).app_user_id;
  }

  const auth = betterAuth({
    secret: deps.config.AUTH_SECRET,
    baseURL: deps.config.AUTH_BASE_URL,
    // MUST match the composition root's mount path or every route 404s.
    basePath: '/api/auth',
    // Supplying this REPLACES better-auth's `[baseURL]` default, so the base URL is restated here
    // rather than assumed — the server-side session-mock route calls the handler with the API's
    // own origin and has to keep working. Deduped, because a deployment whose SPA is served from
    // the API origin would otherwise list it twice. See `AuthDependencies.trustedOrigins`.
    trustedOrigins: [...new Set([deps.config.AUTH_BASE_URL, ...deps.trustedOrigins])],
    database: { db: deps.db.withSchema('auth'), type: 'postgres' },
    advanced: {
      // Postgres plus this flag means better-auth omits the id on insert and the column default
      // (`uuidv7()`) mints it.
      database: { generateId: 'uuid' },
      /**
       * PINNED EXPLICITLY, and this is a security fix rather than a stylistic one.
       *
       * better-auth decides this itself when the option is absent, and it keys the decision off
       * `NODE_ENV`: `create-context.mjs` reads
       * `disableOriginCheck !== undefined ? disableOriginCheck : isTest() ? true : false`, where
       * `isTest()` is `NODE_ENV === 'test' || TEST` (`@better-auth/core`'s `env-impl.mjs`, read at
       * 1.6.23 — measured after a trusted-origin test expected a 403 and received a green 302,
       * i.e. the check was off and the test was proving nothing).
       *
       * Two things are wrong with letting that stand. `NODE_ENV` is NOT this repo's mode switch —
       * ADR-0005 makes `APP_MODE` the only one — so a `NODE_ENV=test` leaking into a staging or
       * production process would silently disable origin AND CSRF validation on every auth route,
       * with no boot warning and no gate to catch it. And in the other direction it made the
       * posture untestable: no suite running under vitest could exercise the real behaviour.
       *
       * `false` means the check is ALWAYS ON, in every tier. Nothing here depends on it being off:
       * the server-side callers send the base URL as their origin, which `trustedOrigins` trusts
       * unconditionally.
       */
      disableOriginCheck: false,
      useSecureCookies,
      defaultCookieAttributes: sessionCookieAttributes,
    },
    // Field mapping per ADR-0011: the library's camelCase fields map to snake_case columns, and
    // `userId` becomes `identity_id`. The primary-key column stays `id`, confined to the auth
    // schema, because better-auth's adapter assumes it.
    user: {
      modelName: 'identity',
      fields: { emailVerified: 'email_verified', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    session: {
      modelName: 'session',
      fields: {
        userId: 'identity_id',
        expiresAt: 'expires_at',
        ipAddress: 'ip_address',
        userAgent: 'user_agent',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    account: {
      modelName: 'account',
      fields: {
        userId: 'identity_id',
        accountId: 'provider_account_id',
        providerId: 'provider_id',
        accessToken: 'access_token',
        refreshToken: 'refresh_token',
        idToken: 'id_token',
        accessTokenExpiresAt: 'access_token_expires_at',
        refreshTokenExpiresAt: 'refresh_token_expires_at',
        createdAt: 'created_at',
        updatedAt: 'updated_at',
      },
    },
    verification: {
      modelName: 'verification',
      fields: { expiresAt: 'expires_at', createdAt: 'created_at', updatedAt: 'updated_at' },
    },
    // Absent when the method is not listed — "never configured", not a disabled flag. When
    // present, email verification is mandatory (ADR-0013).
    ...(methods.includes(AUTH_METHOD.Password)
      ? { emailAndPassword: { enabled: true, requireEmailVerification: true } }
      : {}),
    ...buildSocialProviders(methods, deps.config),
    plugins: [
      ...(methods.includes(AUTH_METHOD.MagicLink)
        ? [
            magicLink({
              sendMagicLink: async ({ email, url }) => {
                // The per-address bucket, checked BEFORE rendering or sending. Without it one
                // client can direct the whole per-IP auth allowance at a single victim address
                // indefinitely — inbox bombing, sender-reputation damage, and cost. The
                // normalized address is the subject key, the same fold `assertSignupAllowed`
                // uses. The address itself never rides a metric attribute; spans and logs only.
                const decision = await deps.magicLinkRateLimiter.tryAcquire(
                  email.trim().toLowerCase(),
                );
                if (!decision.allowed) {
                  throw new APIError('TOO_MANY_REQUESTS', {
                    code: ERROR_CODE.RateLimited,
                    message: 'magic link rate limit exceeded for this address',
                  });
                }
                const { html, text, subject } = await deps.mailRenderer.render({
                  kind: MAIL_TEMPLATE.MagicLink,
                  url,
                });
                const message: MailMessage = { to: email, subject, html, text };
                try {
                  await deps.mailSender.send(message);
                } catch (cause) {
                  // Typed at the funnel, never a bare 500 (ADR-0008). better-auth owns its route's
                  // wire shape, so this surfaces a 503 carrying our own code. The
                  // MagicLinkSendFailedError is the domain-typed cause the client keys on; the
                  // APIError is how better-auth renders that status and code.
                  const appError = new MagicLinkSendFailedError(
                    'magic-link email could not be sent',
                    { cause },
                  );
                  throw new APIError('SERVICE_UNAVAILABLE', {
                    code: appError.code,
                    message: 'magic link could not be sent',
                  });
                }
              },
            }),
          ]
        : []),
    ],
    databaseHooks: {
      user: {
        create: {
          // Rejected BEFORE any `identity` or `app_user` row exists — the earliest hook better-auth
          // exposes on the create path (ADR-0013's signup posture). `user.email` is the
          // pre-mapping logical field better-auth's hook contract exposes, unaffected by this
          // factory's column remapping above.
          before: (user) => {
            try {
              assertSignupAllowed({
                posture: deps.config.AUTH_SIGNUP_POSTURE,
                allowedEmails: parseSignupAllowedEmails(deps.config.AUTH_SIGNUP_ALLOWED_EMAILS),
                email: user.email,
              });
              return Promise.resolve();
            } catch (cause) {
              if (isAppError(cause) && cause.code === ERROR_CODE.Forbidden) {
                return Promise.reject(
                  new APIError('FORBIDDEN', { code: cause.code, message: cause.message }),
                );
              }
              return Promise.reject(cause);
            }
          },
        },
      },
      session: {
        create: {
          // The app-owned user row is created in the AWAITED before-hook, not in
          // `user.create.after`. better-auth 1.6.23 does not guarantee the user's after-hook
          // completes before the session is created, so anything the session's own resolution
          // depends on races it there. `session.create.before` is awaited and its return is used,
          // which makes this deterministic; the ON CONFLICT keeps it a no-op for a returning user.
          // A hook failure surfaces as the sign-in request's error at the HTTP boundary, once
          // (ADR-0008).
          before: async (session) =>
            observability.withSpan('auth.user.provision-hook', async (span) => {
              span.setAttribute('appUserId', await ensureAppUser(session.userId));
              return { data: session };
            }),
        },
      },
    },
  });

  const handler = async (request: Request): Promise<Response> => {
    const response = await auth.handler(request);
    requestCounter.add(1, {
      route: routeGroupOf(new URL(request.url).pathname),
      outcome: response.status < 400 ? AUTH_OUTCOME.Completed : AUTH_OUTCOME.Terminal,
    });
    return response;
  };

  const mountedMethods = deriveMountedMethods(
    auth as unknown as Parameters<typeof deriveMountedMethods>[0],
  );

  // The one better-auth boundary cast: better-auth's `api` type is a deep generic, narrowed here
  // to the minimal {@link AuthApi} the middleware consumes, so nothing else in the repository ever
  // sees a better-auth type.
  return { handler, api: auth.api as unknown as AuthApi, mountedMethods, sessionCookieAttributes };
}

/** Builds the `socialProviders` option only for OAuth methods that are BOTH listed and fully
 * credentialed — the slice's superRefine already guaranteed the pair when a provider is listed.
 * Returns `{}` so the spread adds nothing when none is configured: never configured beats a false
 * flag. */
function buildSocialProviders(
  methods: readonly AuthMethod[],
  config: AuthSliceConfig,
): { socialProviders?: Record<string, { clientId: string; clientSecret: string }> } {
  const providers: Record<string, { clientId: string; clientSecret: string }> = {};
  if (
    methods.includes(AUTH_METHOD.GoogleOAuth) &&
    config.AUTH_GOOGLE_CLIENT_ID !== undefined &&
    config.AUTH_GOOGLE_CLIENT_SECRET !== undefined
  ) {
    providers.google = {
      clientId: config.AUTH_GOOGLE_CLIENT_ID,
      clientSecret: config.AUTH_GOOGLE_CLIENT_SECRET,
    };
  }
  if (
    methods.includes(AUTH_METHOD.GitHubOAuth) &&
    config.AUTH_GITHUB_CLIENT_ID !== undefined &&
    config.AUTH_GITHUB_CLIENT_SECRET !== undefined
  ) {
    providers.github = {
      clientId: config.AUTH_GITHUB_CLIENT_ID,
      clientSecret: config.AUTH_GITHUB_CLIENT_SECRET,
    };
  }
  return Object.keys(providers).length > 0 ? { socialProviders: providers } : {};
}
