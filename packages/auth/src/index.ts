// Public barrel — the module's entire public contract (ADR-0003: one barrel, no nested barrels).
// better-auth is held at arm's length (ADR-0013): every better-auth import lives inside this
// package, enforced by the dependency-cruiser SDK-owner rule, and no better-auth type leaks
// through this barrel.
export { authorLabelsForUserIds, deriveAuthorLabel } from './author-label.js';
export { type AuthSliceConfig, authConfigSlice, parseAuthMethods } from './config-slice.js';
export { MagicLinkSendFailedError } from './errors.js';
export {
  type AuthApi,
  type AuthDependencies,
  type AuthHandle,
  createAuth,
  type SessionCookieAttributes,
} from './factory.js';
export { AUTH_METHOD, AUTH_METHODS_VALUES, type AuthMethod } from './methods.js';
export { assertAuthMethodParity, assertSessionCookiePolicy } from './parity.js';
export { type AuthPurgeResult, purgeExpiredAuthRows, startAuthRetention } from './retention.js';
export {
  createSessionMiddleware,
  type RequestSession,
  requireSession,
  resolveRequestSession,
  type SessionMiddlewareDependencies,
} from './session-middleware.js';
export {
  AUTH_SIGNUP_POSTURE,
  AUTH_SIGNUP_POSTURE_VALUES,
  type AuthSignupPosture,
} from './signup-posture.js';
