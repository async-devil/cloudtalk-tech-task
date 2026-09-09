import { InternalError } from '@repo/kernel';
import type { AuthHandle } from './factory.js';
import type { AuthMethod } from './methods.js';

/**
 * Boot-time assertion (composition root, after {@link createAuth}): the set of flows the better-auth
 * instance actually mounts equals `methods` exactly — both directions
 * (ADR-0013's drift-class killer). A method dropped from the
 * UI but left server-enabled (the reference's H2 drift), or configured-but-unmountable, is a boot
 * failure listing the delta, not a discovery in production. `handle.mountedMethods` is derived from
 * the real instance's endpoint registry and resolved options, so this compares the instance to
 * the claim, never the config to itself.
 *
 * @throws InternalError (named, listing the delta) when the mounted and claimed sets differ.
 */
export function assertAuthMethodParity(
  handle: AuthHandle,
  methods: ReadonlyArray<AuthMethod>,
): void {
  const claimed = new Set(methods);
  const mounted = new Set(handle.mountedMethods);
  const missing = [...claimed].filter((method) => !mounted.has(method));
  const extra = [...mounted].filter((method) => !claimed.has(method));
  if (missing.length > 0 || extra.length > 0) {
    throw new InternalError(
      'auth method parity failed: the mounted flow set does not match config',
      {
        details: {
          claimed: [...claimed],
          mounted: [...mounted],
          claimedButNotMounted: missing,
          mountedButNotClaimed: extra,
        },
      },
    );
  }
}

/**
 * Boot-time assertion (composition root, beside {@link assertAuthMethodParity}): the built
 * instance's session-cookie attributes match the pin — `HttpOnly`, `SameSite=Lax`,
 * `Path=/`, and `Secure` iff `expectSecure`. The pin lives HERE, the
 * value comes off the handle (`handle.sessionCookieAttributes`, set by the factory), so a factory
 * regression — a dropped `HttpOnly`, a `SameSite=None`, a `Secure` that stops tracking the base-URL
 * scheme — fails boot instead of shipping a weakened cookie. `expectSecure` is derived independently
 * by the caller (from `AUTH_BASE_URL`'s scheme), so this also confirms the factory used that rule.
 * the e2e suite reads a real sign-in's `Set-Cookie` for the other half — that better-auth honored them.
 *
 * @throws InternalError (named, listing the delta) when any attribute diverges from the pin.
 */
export function assertSessionCookiePolicy(
  handle: AuthHandle,
  options: { readonly expectSecure: boolean },
): void {
  // Plain object literals (not the named `SessionCookieAttributes` interface): only anonymous
  // object types carry the implicit index signature that makes them assignable to the kernel
  // error's `JsonValue` details.
  const expected = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure: options.expectSecure,
  };
  const actual = handle.sessionCookieAttributes;
  if (
    actual.httpOnly !== expected.httpOnly ||
    actual.sameSite !== expected.sameSite ||
    actual.path !== expected.path ||
    actual.secure !== expected.secure
  ) {
    throw new InternalError('auth session-cookie policy failed: attributes diverge from the pin', {
      details: { expected, actual: { ...actual } },
    });
  }
}
