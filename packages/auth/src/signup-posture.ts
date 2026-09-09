import { ForbiddenError } from '@repo/kernel';

/** The signup posture (ADR-0013). `Open` admits every address; `Allowlist` (the shipped
 * default) rejects any address not exactly listed, before any user row exists. */
export const AUTH_SIGNUP_POSTURE = { Open: 'open', Allowlist: 'allowlist' } as const;
export type AuthSignupPosture = (typeof AUTH_SIGNUP_POSTURE)[keyof typeof AUTH_SIGNUP_POSTURE];
export const AUTH_SIGNUP_POSTURE_VALUES = Object.values(
  AUTH_SIGNUP_POSTURE,
) as readonly AuthSignupPosture[];

/** Parses the comma-separated `AUTH_SIGNUP_ALLOWED_EMAILS` env value into a normalized (trimmed,
 * lowercased) set of exact addresses — one parser shared by the slice's `superRefine` and the
 * enforcement hook, so the two can never drift on what counts as "listed" (case folding, in
 * particular). */
export function parseSignupAllowedEmails(raw: string | undefined): ReadonlySet<string> {
  if (raw === undefined) {
    return new Set();
  }
  return new Set(
    raw
      .split(',')
      .map((token) => token.trim().toLowerCase())
      .filter((token) => token.length > 0),
  );
}

/**
 * The enforcement check: throws {@link ForbiddenError} for a non-allowlisted address under
 * `allowlist` posture; a no-op under `open` posture. Exact-address matching only (case-folded) —
 * no domain wildcards, by the spec's own wording ("comma-separated exact addresses").
 */
export function assertSignupAllowed(options: {
  readonly posture: AuthSignupPosture;
  readonly allowedEmails: ReadonlySet<string>;
  readonly email: string;
}): void {
  if (options.posture === AUTH_SIGNUP_POSTURE.Open) {
    return;
  }
  if (!options.allowedEmails.has(options.email.trim().toLowerCase())) {
    throw new ForbiddenError('signup is not open for this address');
  }
}
