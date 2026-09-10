# @repo/auth

Authentication: the better-auth instance, its Elysia mount, the per-request session middleware, and
the retention pass that purges expired credential rows. Sign-in is a magic link — ADR-0013 records
why, and what that costs. The module holds better-auth at arm's length: every better-auth import in
the repository lives in here, and no better-auth type crosses this barrel. It also owns the one
place an `auth.identity.email` is ever read for display purposes: `authorLabelsForUserIds`
(TASK-0003) derives a review's non-identifying `authorLabel` from it, because `@repo/reviews` has
no sanctioned edge to this schema (ADR-0001) and the email itself must never cross the wire
(SPEC-0001 open question 1).

**When NOT to use this.** Do not reach for `@repo/auth` to answer "may this user do that". It
resolves *who is calling*, and nothing else. Authorization is a domain question — whether a review
belongs to its author, whether a product accepts new reviews — and belongs in the bounded context
that owns the data, filtered on `session.userId`. `authorLabelsForUserIds` is not an exception to
this: it answers "what does this author's byline read", a presentation derivation, never a
permission.

## Public contract

| Export | What it is |
|---|---|
| `createAuth(deps)` → `AuthHandle` | Builds the better-auth instance from the config slice; returns its fetch handler, a narrowed `AuthApi`, the methods it actually mounted, and the session-cookie attributes it was configured with. |
| `AuthDependencies`, `AuthHandle`, `AuthApi`, `SessionCookieAttributes` | The factory's injected ports and its result shape. |
| `resolveRequestSession(deps, headers)` | Framework-agnostic session resolution — the one contract routes use, because Elysia's `.derive` does not fire for a mounted handler. |
| `createSessionMiddleware(deps)` | The Elysia plugin form, for Elysia-native routes. |
| `requireSession(context)` | Guard: returns the session or throws `UnauthorizedError`. |
| `RequestSession` | `{ userId, userToken }` — one dimension, deliberately (ADR-0013). |
| `assertAuthMethodParity`, `assertSessionCookiePolicy` | Boot-time drift checks against the live instance. |
| `authConfigSlice`, `AuthSliceConfig`, `parseAuthMethods` | The config slice and its method-list parser. |
| `AUTH_METHOD`, `AUTH_METHODS_VALUES`, `AuthMethod` | The closed vocabulary of mountable methods. |
| `AUTH_SIGNUP_POSTURE`, `AUTH_SIGNUP_POSTURE_VALUES`, `AuthSignupPosture` | Open or allowlist; ships closed. |
| `purgeExpiredAuthRows`, `startAuthRetention`, `AuthPurgeResult` | The retention pass and its scheduled wiring. |
| `MagicLinkSendFailedError` | The typed send failure the sign-in screen keys on. |
| `deriveAuthorLabel(email)` | The pure SPEC-0001 open-question-1 derivation: local part, trimmed, truncated to 24 chars, `'Reviewer'` fallback. Exported for anywhere the derivation alone is useful; `authorLabelsForUserIds` is the batch, DB-backed form a router actually calls. |
| `authorLabelsForUserIds(db, userIds)` → `Map<string, string>` | Resolves `authorLabel` for a batch of `auth.app_user.app_user_id` values in one round trip (TASK-0003) — the composition-root seam `@repo/reviews`' `ReviewListItem.authorId` exists to feed. The email itself never leaves this function. |

## Dependencies

| Dependency | Why |
|---|---|
| `@repo/kernel` | The error taxonomy this module raises into (`UnauthorizedError`, `InternalError`, and `MagicLinkSendFailedError`'s base). |
| `@repo/contracts` | `MailSenderPort` and `MailRendererPort` — consumed, never implemented here. |
| `@repo/entities` | The user token prefix and the minter; public identifiers are minted centrally. |
| `@repo/config` | Slice definition and the fail-closed mode helpers. |
| `@repo/observability` | The facade every span, log and counter here rides. |
| `@repo/messaging` | `SlidingWindowRateLimiter`, injected for the per-address magic-link bucket, and the scheduler behind the retention pass. |
| `@repo/persistence` | `rowAs` — this module writes hand-written SQL, so its rows parse at the boundary. A sanctioned capability-to-capability edge. |
| `better-auth` | The auth library. Confined to this package by the dependency-cruiser SDK-owner rule, with one named exception for the SPA's client. |
| `elysia` | Only for the optional session plugin; the core resolution is framework-agnostic. |
| `kysely`, `zod` | The database handle type and the slice schema. |

## Config slice

| Key | Required | Notes |
|---|---|---|
| `AUTH_SECRET` | live | Signing secret. A development default exists in `test` only. |
| `AUTH_BASE_URL` | live | Also decides `Secure` on session cookies, via its scheme. |
| `AUTH_METHODS` | yes | Comma-separated; an unlisted method is not mounted at all. |
| `AUTH_GOOGLE_CLIENT_ID` / `_SECRET` | pair | Required together iff `google-oauth` is listed. |
| `AUTH_GITHUB_CLIENT_ID` / `_SECRET` | pair | Required together iff `github-oauth` is listed. |
| `AUTH_SIGNUP_POSTURE` | no | `open` or `allowlist`; defaults to `allowlist`. |
| `AUTH_SIGNUP_ALLOWED_EMAILS` | with allowlist | Comma-separated addresses. |
| `AUTH_SESSION_RETENTION_DAYS` | no | Horizon for the expired-session purge. |
| `AUTH_VERIFICATION_RETENTION_DAYS` | no | Horizon for the verification-payload purge. |

## Named invariants

- **INV-1** — An unlisted method is never configured, not merely disabled: the server cannot serve
  a flow it did not mount (→ `test/config-slice.test.ts::parseAuthMethods`).
- **INV-2** — `assertAuthMethodParity` compares the claimed method list against what the live
  instance actually mounted, so a config that lies fails at boot rather than at first request
  (→ `test/parity.test.ts::assertAuthMethodParity`).
- **INV-3** — Session cookies are `HttpOnly; SameSite=Lax; Path=/`, with `Secure` in any tier whose
  base URL is https. `SameSite=None` is unconstructible here (→
  `test/parity.test.ts::assertSessionCookiePolicy`).
- **INV-4** — Signup posture is enforced before any `identity` or `app_user` row exists, so a
  rejected address leaves no trace (→ `test/signup-posture.test.ts::assertSignupAllowed`).
- **INV-5** — The magic-link send path checks a per-recipient-address bucket before rendering or
  sending, so one client cannot direct its whole per-IP allowance at a single victim address.
- **INV-6** — The session-create hook is replay-safe: a second run for the same identity is a no-op
  insert and a re-read, never a duplicate `app_user`.
- **INV-7** — Email addresses, tokens and magic-link URLs never appear in logs. The redaction list
  covers `email` and `token`, and this module never logs a URL at all.
- **INV-8** — `purgeExpiredAuthRows` refuses a horizon below its floor rather than silently
  deleting live sessions (→ `test/units.test.ts::purgeExpiredAuthRows floors`).
- **INV-9** — `deriveAuthorLabel` never returns the email itself in any form (no `@`, no domain
  substring), truncates to exactly 24 characters with no ellipsis, and falls back to the literal
  `'Reviewer'` only when nothing is left after trimming the local part (SPEC-0001 open question 1)
  (→ `test/author-label.test.ts`).

## Telemetry

Source records: [ADR-0013](../../docs/adr/ADR-0013-authentication-and-security-baseline.md),
[ADR-0009](../../docs/adr/ADR-0009-observability-through-a-facade.md) and
[TASK-0003](../../docs/tasks/TASK-0003-products-and-reviews-api.md).

Spans:

- `auth.session.resolve` — one per session resolution; carries `appUserId`, never an email.
- `auth.retention.run` — one per retention pass over the expired credential rows.
- `auth.user.provision-hook` — the awaited session-create hook that ensures the app-owned user row.
- `auth.author.label` (TASK-0003) — one per `authorLabelsForUserIds` call; carries no attributes —
  neither the emails it reads nor the ids it batches ever reach a span attribute here.

Instruments:

| Name | Kind | Attributes | Values |
|---|---|---|---|
| `auth.request.handle` | counter | `route`, `outcome` | route ∈ sign-in, callback, session, other; outcome ∈ completed, terminal |
| `auth.retention.purged` | counter | `queue`, `outcome` | outcome names the evidence table purged |

Route groups are a closed set mapped from the request path, so per-endpoint ids never reach a
metric attribute (ADR-0009).

## Extraction

```
bun run extract-module auth
```
