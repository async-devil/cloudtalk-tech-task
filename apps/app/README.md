# @repo/app

The React 19 + Vite SPA behind the api's session cookie: TanStack Router for routing, TanStack
Query for all server state, isolated feature slices over a shared kernel, styled exclusively
through `@repo/styles`' tokens and vendored primitives. ADR-0012 is the record that argues this
shape; what follows describes what is actually built under it.

**When NOT to put something here.** This app is UI composition and wiring, not a second copy of
the backend. A rule about what a review or a product IS, an authorization decision, or anything
the wire contract does not already answer belongs in the module that owns it behind
`@repo/contracts` — this app only renders what a contract call returns and calls what a contract
declares. There is also deliberately no client-state container (ADR-0012): if something here wants
a store, it is almost always server state that belongs behind `shared/api`/TanStack Query instead
of a new local one.

## Structure

Three top-level areas under `src/`, per ADR-0012:

| Folder | What lives there |
|---|---|
| `routes/` | Thin route modules: URL-level concerns only — search-param parsing/validation (`routes/sign-in.tsx`'s `returnTo`), the root guard (`routes/__root.tsx`) — and composing a feature's screen. A route never owns flow logic. |
| `features/<slice>/` | One user-facing flow each. Today there is exactly one: `sign-in` (`sign-in-screen.tsx` plus its pure `useReducer` machine, `request-magic-link-machine.ts`). |
| `shared/` | The app kernel: `api` (the one oRPC client), `session` (the session-bootstrap query and the better-auth client), `query-keys` (the derived key factory), `errors` (the one client error shape and the one 401 handler), `observability` (the one error-reporting boundary), `analytics` (a no-op-by-default event tracker). |

## Slice isolation (ADR-0012)

- A slice never imports another slice, and never imports a route. Code two slices need moves to
  `shared/` — that is what makes a feature folder deletable.
- `shared/` never imports a route or a feature. The graph is one-directional: shared is the kernel,
  and a kernel that reaches back into a feature is not one.
- Enforced by two `fe-slice-isolation` rules in the root `.dependency-cruiser.cjs` (search it for
  `apps/app/src/features`): one forbids `shared/` → `routes/`/`features/`, the other forbids one
  feature folder → any other feature folder or a route, matched with a back-reference so a
  feature's own internal imports stay unaffected.
- With only one feature slice implemented so far, the cross-feature half of this rule has not yet
  been exercised by a real second feature — only by the dependency-cruiser fixture at
  `tools/arch-checks/test/fixtures/violations/feature-imports-feature`.

## Network access

`shared/api` builds the app's one oRPC client (`apiClient`) and its TanStack Query bindings
(`apiQuery`), typed end-to-end from `@repo/contracts`' `appContract` — the contract is the SDK, so
no route or payload shape is restated here. `credentials: 'include'` is re-applied to every
request because the session cookie is `HttpOnly` and the SPA is always cross-origin from the api.

`shared/session/auth-client.ts` is a second, sanctioned door to the network: better-auth's own
client, because the magic-link/callback routes are better-auth's, not `appContract`'s, and there is
no contract procedure to call instead. It is the one file listed by exact path
(`alsoAllowedFrom`) in `tools/arch-checks/src/module-registry.cjs`'s `SDK_OWNERS` entry for
`better-auth`, which is what lets the dependency-cruiser `adapters-and-sdk-only-in-runtime` rule
allow it while still confining every other `better-auth` import to `packages/auth`.

**Accuracy note.** ADR-0012 states the intended law as "a `fetch` elsewhere is a gate failure," and
the comments in `shared/api/index.ts` and `shared/session/auth-client.ts` both cite a
`no-fetch-outside-shared-api` gate at `tools/arch-checks/src/no-fetch-outside-shared-api.ts`. That
file does not exist, and neither `.dependency-cruiser.cjs` nor any script in `tools/arch-checks/`
polices a bare `fetch(` call — checked directly against both. So today this is a design intent and
a code-review discipline, not a machine-checked one: a third component that called `fetch` directly
would compile and pass every gate `bun moon ci` runs. The two doors named above are the only ones
that exist in this codebase, but nothing yet stops a third from opening.

## Composition root

`main.tsx` constructs the app's only stateful things — the `QueryClient` and the router
(`createAppRouter`) — then renders `RouterProvider`, mirroring ADR-0005's composition-root rule in
its frontend form: everything else is a pure function of what it is given. `router.tsx` builds the
router from the generated route tree and, once, installs:

- the app's ONE error boundary (`defaultErrorComponent`), the only caller of
  `observability.reportError`;
- the app's ONE 401 handler (`installUnauthorizedRedirect`), subscribed to both the query and the
  mutation cache, which redirects to `/sign-in` carrying the location the user was on.

## Error handling (ADR-0008, frontend form)

The browser has no `@repo/observability` facade — that package is server-side pino/OTel wiring —
so "errors are handled once, at a boundary" lands on two files instead. `shared/errors` is the one
client-side error shape: `toApiError`/`toApiErrorFromAuthResponse` normalize anything a call can
throw or resolve-with-error into an `ApiError`, and `errorMessageFor` is a `Record<ErrorCode,
string>` total over the kernel's closed vocabulary, so a new error code with no copy is a compile
error rather than a blank banner. `shared/observability` is the one reporting boundary, named
explicitly by its caller (`router.tsx`'s error component) so it is provably a boundary and not an
unused claim; with no provider wired it writes to the console in development only.

## Config slice

None from `@repo/config` — this is a browser bundle with no access to server env. Its one setting
is `VITE_API_URL` (optional, defaults to `http://localhost:3000`), read through
`import.meta.env` in `shared/api/index.ts` — the documented exception to "never read env outside
`@repo/config`," because Vite inlines `VITE_*` values at build time rather than at process start.
It is parsed with `z.url()` at module load, so a mistyped value fails loudly instead of every
request 404ing against a nonsense origin.

## Route tree codegen

`src/routeTree.gen.ts` is committed source, generated from `src/routes/**` by `moon run
app:route-tree` (`tsr generate`, then a Biome pass for byte-stable output) and re-checked by
`app:route-tree-check` (`scripts/check-route-tree.ts`: regenerate into a sibling temp file, diff,
delete). Deliberately not a Vite build-time plugin — see `vite.config.ts`'s header — so exactly one
generator produces the tree and CI can diff what is committed against what `routes/` actually
contains.

## Named invariants

- **INV-1** — With no session, the root guard redirects to `/sign-in` carrying the exact attempted
  location as `returnTo` (→ `test/root-guards.test.tsx`).
- **INV-2** — A public route (`PUBLIC_ROUTES`) never triggers a session-bootstrap call at all — a
  public page asks no questions (→ `test/root-guards.test.tsx`).
- **INV-3** — `/sign-in`'s `returnTo` search param is accepted only as a same-origin path (a
  leading `/` that is not `//`); anything else degrades to `/` rather than erroring, closing the
  open-redirect this parameter would otherwise be (→ `test/sign-in-route.test.tsx`).
- **INV-4** — The one 401 handler is subscribed to both the query and the mutation cache, redirects
  on `UNAUTHORIZED` from either, and ignores every other failure — features still own their own
  errors (→ `test/unauthorized-redirect.test.ts`).
- **INV-5** — The router's one error boundary reports a failed navigation through `observability`
  exactly once, not once per re-render, and renders registered copy rather than the backend's own
  operator-facing message (→ `test/router-error-boundary.test.tsx`).
- **INV-6** — `queryKeys` are derived from `apiQuery`'s own nested-array key shape, so a
  slice-prefix `invalidateQueries` actually reaches an `apiQuery`-keyed entry; a hand-written flat
  array key would match nothing (→ `test/query-keys.test.ts`).
- **INV-7** — The sign-in machine refuses a second submit while one is already in flight, and
  editing the address after a "sent" confirmation clears both the confirmation and any error
  (→ `test/request-magic-link-machine.test.ts`).
- **INV-8** — A magic-link call that REJECTS outright (a dropped connection), not only one that
  resolves with an error, still leaves the machine out of `Submitting` and the form usable again
  (→ `test/sign-in-screen-failure.test.tsx`).
- **INV-9** — `analytics.track` and `observability.reportError` never throw with no provider wired,
  and `reportError` normalizes through `toApiError` before reporting, so what is reported agrees
  with what the UI showed (→ `test/wrappers.test.ts`).
- **INV-10** — The design-system primitives' props are a closed set enforced by the TypeScript
  compiler, not a scanner: an undeclared prop or an out-of-union `variant`/`size` fails
  `app:typecheck` directly (→ `test/primitive-typing-witness.tsx`, a compile-only assertion with no
  runtime body — see its own header for why).

## Telemetry

None. This app carries no `@repo/observability` import and emits no OpenTelemetry spans or
metrics — the browser has no access to that server-side facade. The client-side wrappers described
under Error handling above (`shared/observability`, `shared/analytics`) are console/provider hooks
for a future error-reporting or analytics vendor, not a telemetry emitter, so there is nothing here
for the telemetry-map gate to reconcile.

## End-to-end tests

`apps/app/e2e/` (Playwright; not part of `bun moon ci` — see `moon.yml`'s `e2e` task header for
why a dedicated `.github/workflows` job runs it directly instead):

- `harness/start-api-server.ts` brings up the compose Postgres/Redis, migrates, and boots the REAL
  `apps/api` composition root under `APP_MODE=test` — the suite drives the built SPA against the
  real backend, never a mock.
- `harness/session-mock.ts` mints a real better-auth session through the test-only session-mock
  route, so most specs skip driving the magic-link UI by hand.
- `specs/smoke.spec.ts` — the built SPA serves `/sign-in`.
- `specs/session-mock-auth.spec.ts` — the mock actually mints a session the api recognizes.
- `specs/magic-link.spec.ts` — the one spec that drives the real magic-link flow end to end, as
  proof of what the mock stands in for elsewhere.
- `specs/accessibility.spec.ts` — visible focus rings, 44×44 touch targets, keyboard-only
  completion, and accessible-name reachability on `/sign-in` (ADR-0012's accessibility floor).

## Extraction

Apps are deployables, not liftable modules — the named exception in ADR-0001. There is no
`extract-module` run for this package.
