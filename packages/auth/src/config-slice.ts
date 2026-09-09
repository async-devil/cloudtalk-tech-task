import { defineConfigSlice, isFailClosed } from '@repo/config';
import { z } from 'zod';
import { AUTH_METHOD, AUTH_METHODS_VALUES, type AuthMethod } from './methods.js';
import {
  AUTH_SIGNUP_POSTURE,
  AUTH_SIGNUP_POSTURE_VALUES,
  parseSignupAllowedEmails,
} from './signup-posture.js';

/** Fixed, obviously-insecure dev literal (ADR-0010: `test` tier defaults; real tiers require the
 * key). better-auth's signing secret in `test`; a real deployment supplies its own. */
const DEV_AUTH_SECRET = 'dev-only-insecure-auth-secret-change-me-000000';

/**
 * Parses the comma-separated `AUTH_METHODS` env value into the closed {@link AuthMethod} list.
 * Used by BOTH the slice's `superRefine` (to validate at boot) and the factory (to read the list
 * post-parse) — one parser, no drift. Unknown tokens and an empty list are reported by the caller
 * via the returned discriminated result; this function never throws.
 */
export function parseAuthMethods(
  raw: string,
):
  | { readonly ok: true; readonly methods: readonly AuthMethod[] }
  | { readonly ok: false; readonly badToken: string } {
  const tokens = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  const methods: AuthMethod[] = [];
  for (const token of tokens) {
    const parsed = z.enum(AUTH_METHODS_VALUES).safeParse(token);
    if (!parsed.success) {
      return { ok: false, badToken: token };
    }
    methods.push(parsed.data);
  }
  return { ok: true, methods };
}

/**
 * The `auth` config slice (ADR-0005: layered, fail-closed, composed from per-module slices):
 *
 * | env key | required | default (test) |
 * |---|---|---|
 * | `AUTH_SECRET` | staging/production | fixed dev literal |
 * | `AUTH_BASE_URL` | staging/production | `http://localhost:3000` |
 * | `AUTH_METHODS` | no | `magic-link` |
 * | `AUTH_GOOGLE_CLIENT_ID` / `AUTH_GOOGLE_CLIENT_SECRET` | pair, iff `google-oauth` | — |
 * | `AUTH_GITHUB_CLIENT_ID` / `AUTH_GITHUB_CLIENT_SECRET` | pair, iff `github-oauth` | — |
 *
 * The slice's parsed output is the RAW env keys (so the boot report and `.env.example` sync stay
 * consistent with every other slice); the factory turns `AUTH_METHODS` into the mounted method set
 * via {@link parseAuthMethods}. `superRefine` fails closed on an unknown/empty method list and on a
 * half-configured or method-missing OAuth credential pair (all-or-nothing, ADR-0010).
 */
export const authConfigSlice = defineConfigSlice('auth', (mode) =>
  z
    .object({
      AUTH_SECRET: (isFailClosed(mode)
        ? z.string().min(1)
        : z.string().min(1).default(DEV_AUTH_SECRET)
      ).describe('Live-required. better-auth signing secret; a deployment supplies its own.'),
      AUTH_BASE_URL: (isFailClosed(mode)
        ? z.url()
        : z.url().default('http://localhost:3000')
      ).describe(
        'Live-required. Absolute origin magic links are minted against. Its scheme also decides ' +
          'the Secure cookie attribute: https ⇒ Secure, http ⇒ not.',
      ),
      AUTH_METHODS: z
        .string()
        .min(1)
        .default(AUTH_METHOD.MagicLink)
        .describe(
          'Comma-separated mountable methods. Values: magic-link | password | google-oauth | ' +
            'github-oauth. Empty ⇒ boot failure.',
        ),
      AUTH_GOOGLE_CLIENT_ID: z
        .string()
        .min(1)
        .optional()
        .describe('Required as a PAIR with AUTH_GOOGLE_CLIENT_SECRET iff google-oauth is listed.'),
      AUTH_GOOGLE_CLIENT_SECRET: z
        .string()
        .min(1)
        .optional()
        .describe('Required as a PAIR with AUTH_GOOGLE_CLIENT_ID iff google-oauth is listed.'),
      AUTH_GITHUB_CLIENT_ID: z
        .string()
        .min(1)
        .optional()
        .describe('Required as a PAIR with AUTH_GITHUB_CLIENT_SECRET iff github-oauth is listed.'),
      AUTH_GITHUB_CLIENT_SECRET: z
        .string()
        .min(1)
        .optional()
        .describe('Required as a PAIR with AUTH_GITHUB_CLIENT_ID iff github-oauth is listed.'),
      AUTH_SIGNUP_POSTURE: z
        .enum(AUTH_SIGNUP_POSTURE_VALUES)
        .default(AUTH_SIGNUP_POSTURE.Allowlist)
        .describe(
          'ADR-0013. open | allowlist. Ships closed (allowlist) — open ' +
            'signup is one explicit config flip, visible in config review.',
        ),
      AUTH_SIGNUP_ALLOWED_EMAILS: z
        .string()
        .optional()
        .describe(
          'Comma-separated exact addresses admitted to sign up under the allowlist posture. ' +
            'Required non-empty when AUTH_SIGNUP_POSTURE=allowlist in a fail-closed tier.',
        ),
    })
    .superRefine((value, ctx) => {
      if (
        value.AUTH_SIGNUP_POSTURE === AUTH_SIGNUP_POSTURE.Allowlist &&
        isFailClosed(mode) &&
        parseSignupAllowedEmails(value.AUTH_SIGNUP_ALLOWED_EMAILS).size === 0
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_SIGNUP_ALLOWED_EMAILS'],
          message:
            'AUTH_SIGNUP_ALLOWED_EMAILS must be non-empty when AUTH_SIGNUP_POSTURE=allowlist in a fail-closed tier',
        });
      }
      const parsed = parseAuthMethods(value.AUTH_METHODS);
      if (!parsed.ok) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_METHODS'],
          message: `unknown auth method "${parsed.badToken}" (allowed: ${AUTH_METHODS_VALUES.join(', ')})`,
        });
        return;
      }
      if (parsed.methods.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['AUTH_METHODS'],
          message:
            'AUTH_METHODS must list at least one method — an auth module with no methods is a misconfiguration',
        });
        return;
      }
      requireOAuthPair(ctx, {
        method: AUTH_METHOD.GoogleOAuth,
        listed: parsed.methods.includes(AUTH_METHOD.GoogleOAuth),
        idKey: 'AUTH_GOOGLE_CLIENT_ID',
        secretKey: 'AUTH_GOOGLE_CLIENT_SECRET',
        id: value.AUTH_GOOGLE_CLIENT_ID,
        secret: value.AUTH_GOOGLE_CLIENT_SECRET,
      });
      requireOAuthPair(ctx, {
        method: AUTH_METHOD.GitHubOAuth,
        listed: parsed.methods.includes(AUTH_METHOD.GitHubOAuth),
        idKey: 'AUTH_GITHUB_CLIENT_ID',
        secretKey: 'AUTH_GITHUB_CLIENT_SECRET',
        id: value.AUTH_GITHUB_CLIENT_ID,
        secret: value.AUTH_GITHUB_CLIENT_SECRET,
      });
    }),
);

function requireOAuthPair(
  ctx: z.core.$RefinementCtx,
  spec: {
    readonly method: AuthMethod;
    readonly listed: boolean;
    readonly idKey: string;
    readonly secretKey: string;
    readonly id: string | undefined;
    readonly secret: string | undefined;
  },
): void {
  const bothPresent = spec.id !== undefined && spec.secret !== undefined;
  const bothAbsent = spec.id === undefined && spec.secret === undefined;
  // All-or-nothing (ADR-0010): a half-configured pair is a misconfiguration even when the method
  // is not listed.
  if (!bothPresent && !bothAbsent) {
    ctx.addIssue({
      code: 'custom',
      path: [spec.id === undefined ? spec.idKey : spec.secretKey],
      message: `${spec.idKey} and ${spec.secretKey} must be set together (all-or-nothing)`,
    });
    return;
  }
  // Required when the method IS listed.
  if (spec.listed && !bothPresent) {
    ctx.addIssue({
      code: 'custom',
      path: [spec.idKey],
      message: `${spec.method} is enabled but ${spec.idKey}/${spec.secretKey} are not set`,
    });
  }
}

/** The parsed output of {@link authConfigSlice}. */
export type AuthSliceConfig = z.infer<ReturnType<typeof authConfigSlice.schema>>;
