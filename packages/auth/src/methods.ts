/**
 * Closed vocabulary of mountable auth methods (ADR-0003: closed value sets are const objects).
 * OAuth providers are each a method: enabling one requires its full credential pair —
 * all-or-nothing, per ADR-0005's fail-closed posture. The `AuthMethod` union and the
 * `AUTH_METHODS_VALUES` list both derive from this one source, so the config slice's `z.enum` can
 * never drift from what the factory mounts.
 */
export const AUTH_METHOD = {
  MagicLink: 'magic-link',
  Password: 'password',
  GoogleOAuth: 'google-oauth',
  GitHubOAuth: 'github-oauth',
} as const;
export type AuthMethod = (typeof AUTH_METHOD)[keyof typeof AUTH_METHOD];

/** The method value list, for the slice's per-entry `z.enum`. */
export const AUTH_METHODS_VALUES = Object.values(AUTH_METHOD) as readonly AuthMethod[];
