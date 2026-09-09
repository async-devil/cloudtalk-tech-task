---
id: SPEC-0001
title: The product — actors, rules, journeys and screens
status: draft
supersedes: []
adr: [ADR-0012, ADR-0014, ADR-0016, ADR-0018]
date: 2026-09-09
---

## Context

The brief asks for "a system for product reviews (like on Amazon or Alza) including a frontend app"
(`docs/assignment.md`). Everything downstream of that sentence — four tables in TASK-0002, six routes
in TASK-0003, three feature slices in TASK-0004 — names its subject without defining it. This
document defines it: what a person can do, what the system refuses, and what each screen shows while
it is loading, empty, failing, or signed out.

What already exists and is not re-specified here: magic-link sign-in and the session model
(ADR-0018, `packages/auth`), the SPA shell, its router, guards and the sign-in screen
(`apps/app/src/features/sign-in/`), and the design tokens and primitives in `packages/styles`.

The scope is the brief's, plus the seams for what comes after. A review site's full surface —
helpfulness votes, verified purchase, images, seller replies — is named at the end of the
Specification with the seam each would use, and is deliberately not built. Moderation is not one of
those: it is specified below.

## Specification

### Actors

| Actor | How the system knows them | What they may do |
|---|---|---|
| Visitor | No session cookie | Browse the catalogue, open a product, read reviews |
| Reviewer | A resolved session (ADR-0018) | Everything a visitor may do, plus submit, edit and delete **their own** review |
| Catalogue manager | A session whose user holds `catalogue_manager` | Everything a reviewer may do, plus create and edit catalogue products |
| Moderator | A session whose user holds `moderator` | Everything a reviewer may do, plus reject a review and restore a rejected one |

Both capabilities are flags on a reviewer, not a separate kind of account: the same person writes
reviews, and holding one capability implies nothing about the other (ADR-0018). There is no admin
area — the authoring and moderation actions live on the screens where their subjects are, and the
capability decides whether they render. The server is what actually refuses either action; the
render decision is a courtesy.

### Domain objects

- **Product** — a catalogue item: name, description, category, price. **Addressed by its `slug`**
  (`/products/sony-wh-1000xm5`) and carrying a **`sku`**, the identifier the business already uses
  (`AUD-WH1000XM5`). Both are unique and neither changes after creation (ADR-0016). Created by a
  catalogue manager in the app, and seeded for a fresh checkout (TASK-0006).
- **Review** — one reviewer's rating (1–5) with a title and a body, attached to one product.
  Identified publicly by a `rev_…` token. Carries a moderation state (`published` or `rejected`
  in v1 — see rule 5 below); only a `published` review appears on any read.
- **Rating aggregate** — a product's average rating and review count, with the time it was computed.
  Derived, rebuildable, and eventually consistent (ADR-0014).
- **Reviewer** — the app-owned user record (`auth.app_user`), identified publicly by a `usr_…`
  token. It has an email and no profile; a review displays its author as a stable non-identifying
  label (see Open question 3).

### The rules the product is

1. A rating is an integer from 1 to 5. There are no half-stars and no unrated reviews.
2. One review per author per product. A second submission is refused (`CONFLICT`), not merged into
   the first, not silently updated.
3. A product's slug and SKU are fixed at creation. A rename changes the name, never the address —
   links do not rot, and a SKU that could change would not be an identifier.
4. Only a catalogue manager may create or edit a product. The screens hide what a person cannot do;
   the server refuses it regardless, which is the half that counts.
5. An author may edit or delete only their own review. Anyone else's returns `FORBIDDEN` — the same
   answer whether or not the review exists, so the endpoint is not an existence oracle.
6. Editing a review keeps its identity and its `created_at`; the list shows it as edited.
7. Deleting a review removes the row. The aggregate follows on the next recomputation.
8. A submitted review is visible to its author immediately, because the review list reads the
   authoritative table (ADR-0014).
9. Only a moderator may reject a review or restore a rejected one (ADR-0018). The screens hide what
   a person cannot do; the server refuses it regardless — the same shape as rule 4.
10. Moderation is post-publication and reversible: a review is `published` on submission and stays
    visible until a moderator rejects it; a rejection can be undone by restoring it. Rejecting or
    deleting a review are different operations with different consequences — deletion is the
    author's own act on their own row and destroys it; rejection is a moderator's act on anyone's
    row and can be reversed.
11. A rejected review is excluded from every scoped read: the product's review list, the author's
    own-review lookup on product detail, and the rating aggregate. It is not deleted, and it
    reappears exactly as it was the moment it is restored.
12. Rejecting or restoring a review changes which reviews count toward the product's aggregate, so
    the transition recomputes it the same way a submission does (SPEC-0004) — moderation is a write
    to the authoritative table, not a side channel the projection can miss.
13. The aggregate may lag. Every place it appears also says when it was computed. **The UI never
   computes an average locally to hide the lag** — showing a number that is about to change is worse
   than showing one that is honestly a moment old.
14. A product with no reviews has no average. The UI shows "No reviews yet", never `0.0`.
15. Reading is anonymous. Writing requires a session, and an anonymous write is answered `401` before
   it reaches any pipeline.

### Journeys

**J1 — browse and read.** Catalogue → filter or search → open a product → read its reviews, page by
page. No session at any point.

**J2 — submit a review.** Product detail → *Write a review* → rating, title, body → submit → the
review appears at the top of the list, marked as the author's own; the aggregate still shows its
previous value with its computed-at time, and refreshes on the next poll or navigation.

**J3 — submit while signed out.** Product detail → *Write a review* → the form is shown with a
sign-in prompt in place of the submit button (never a modal that loses the draft) → sign in → return
to the same product with the in-progress rating, title and body preserved. The draft is held in
`sessionStorage` under a product-scoped key, written on change and cleared on successful submission
or explicit cancel.

**J4 — edit or delete.** Product detail → the author's own review carries *Edit* and *Delete* →
edit re-uses the submission form pre-filled; delete asks for confirmation in a focus-trapped dialog
and cannot be triggered twice.

**J5 — author a product (catalogue manager).** Catalogue → *New product* → name, description,
category, price, SKU, with the slug previewed live from the name and editable before the first save
→ create → land on the new product's detail screen, which shows "No reviews yet" and no average,
because no recomputation has run and none is owed (SPEC-0004). Editing a product later reaches the
same form with slug and SKU shown but not editable, each with the reason beside it.

**J6 — the second review.** An author who already reviewed a product sees their review and an
*Edit* action, not a submission form. If a stale client submits anyway, the `CONFLICT` answer is
rendered as "You have already reviewed this product" with a link to their review — a typed answer
turned into a route, not an error toast.

**J7 — moderate a review.** Moderation screen → filterable list of reviews → *Reject* on a
`published` row moves it to `rejected` and it drops out of the list a visitor sees for that product;
*Restore* on a `rejected` row reverses it. Both actions recompute the product's rating (SPEC-0004).

### Screens

Each screen states what it reads, what it shows in every state, and its keyboard contract. Routes
are TanStack Router file routes under `apps/app/src/routes/`; the work lives in the feature slices
named in the Slice map below.

#### S1 — Sign in (`/sign-in`) — exists

Email field, submit, and a "check your inbox" confirmation. Unchanged by this specification except
for one addition: it preserves and honours a `redirect` search param, so J3 returns to the product
rather than the catalogue. Error copy keys on `MAGIC_LINK_SEND_FAILED` and `RATE_LIMITED`.

#### S2 — Catalogue (`/`)

Replaces today's placeholder home route (`apps/app/src/routes/index.tsx`).

- **Reads:** `products.list` (SPEC-0003), which serves the rating projection.
- **Controls:** a search box (substring on product name, debounced, mirrored into the URL as a search
  param so a result set is linkable); a category filter; a sort control — *Highest rated*, *Most
  recent*, *Name*. Every control is a URL search param; the URL is the state.
- **Card:** name, category, price, average rating as stars plus the numeric value, review count, and
  a muted "rated … ago" line derived from `ratingComputedAt`.
- **States:** *loading* — skeleton cards, no layout shift; *empty (no products)* — a plain statement,
  which after seeding means something is wrong, so it also links to the setup section; *empty (filter
  matched nothing)* — the filter echoed back with a clear-filters action; *error* — the message-map
  copy for the code, with retry; *unrated product* — "No reviews yet" in place of the stars.
- **Manager affordance:** a *New product* action, rendered only when the session bootstrap reports
  `canManageCatalogue` (S7). Hiding it is courtesy; the server is what refuses.
- **Pagination:** a *Load more* action appending the next cursor page. Not infinite scroll: it takes
  the keyboard focus away from nobody and needs no scroll restoration.
- **Keyboard:** every card is a link; the filter controls are native form controls; nothing is a
  click-handler on a `div`.

#### S3 — Product detail (`/products/$productSlug`)

- **Reads:** `products.get` for the product and its aggregate, `reviews.listForProduct` for the
  reviews. Two queries, deliberately: one is the projection and one is the truth (ADR-0014), and
  they invalidate on different events.
- **Header:** name, category, price, SKU, description; an *Edit product* action for a catalogue
  manager (S7) and nothing where it would be for anyone else; the aggregate as stars, the numeric average to one
  decimal, the review count, and the computed-at line spelled out — "Average from 24 reviews,
  calculated 2 minutes ago".
- **Own-review block:** when the session's user has a review, it is pulled out above the list with
  *Edit* and *Delete*. When they do not, the *Write a review* action opens S4 in place.
- **Review list:** rating, title, body, author label, submitted date, an "edited" marker when
  `updated_at` differs from `created_at`. Ordered newest first. Cursor-paginated with *Load more*.
  Only `published` reviews appear (rule 11) — there is no "removed" placeholder in the list; a
  rejected review's slot simply closes up, the same as a deleted one.
- **States:** *loading* — header skeleton, then list skeleton, so the product renders before its
  reviews; *unknown token* — the 404 screen (S6), not an empty product; *no reviews* — "Be the first
  to review this product" with the submit action; *list error while header succeeded* — the list
  region alone shows the error, the header stays.

#### S4 — Review form (in place on S3; `?review=new` / `?review=edit`)

Not a separate route: it is a section of the product screen, and its open state is a search param so
J3's round trip through sign-in returns to exactly it.

- **Fields:** rating (required), title (required, 3–120 characters), body (required, 10–4000
  characters), with a live character counter that warns before the limit rather than truncating.
- **The rating control:** a radio group of five stars — arrow keys move, `Home`/`End` jump to the
  ends, `Space`/`Enter` select, and the group is labelled and announces its current value
  ("3 of 5 stars"). Hover and focus preview a value without committing it. This is the one new
  primitive this specification adds to `packages/styles`, and it carries the keyboard and labelling
  tests the other primitives carry (ADR-0012).
- **Submission:** the button is disabled while in flight and the form is not re-submittable by a
  second `Enter`. Client-side validation mirrors the wire schema; the server's answer wins.
- **Errors:** by code — `VALIDATION` renders per-field messages from `details`; `CONFLICT` becomes
  J6's copy; `UNAUTHORIZED` triggers J3's sign-in round trip with the draft preserved;
  `RATE_LIMITED` says when to retry; everything else is the generic failure copy with the draft
  intact. **Nothing is destroyed by a failed submission.**
- **After success:** the form closes, the review list is invalidated and refetched, the new review is
  focused (so a screen reader lands on it), and the aggregate is *not* touched — it will update when
  the projection does.

#### S5 — Delete confirmation

A dialog on Radix behaviour (focus trap, `Escape` to dismiss, focus returned to the trigger).
Names the product and the rating being removed, and its confirm action is destructive-styled. In
flight it disables both actions rather than closing optimistically.

#### S7 — Product create / edit (`/products/new`, `/products/$productSlug/edit`)

Reachable only when the session bootstrap reports `canManageCatalogue`; a visitor who types the URL
gets the same answer the server gives — the route redirects to the product or the catalogue, and the
API returns `403` if the client tries anyway.

- **Fields:** name (required), description (required), category (a select over the vocabulary),
  price with its currency, and SKU (required, uppercase, format hinted inline rather than explained
  after failure).
- **Slug:** previewed live beneath the name field — "will be published at `/products/sony-wh-1000xm5`"
  — derived client-side for the preview and **server-side for the value**. An *Edit slug* action
  reveals the field before the first save; after creation it is shown, disabled, with the reason
  ("the address is fixed so links keep working"), and so is the SKU.
- **Conflicts:** a duplicate slug or SKU comes back as `CONFLICT` with `details.field`, and the
  message attaches to that input rather than to the form. Nothing in the form is cleared.
- **Keyboard and focus:** one native form, submit on `Enter`, disabled while in flight, and on
  success focus lands on the new product's heading rather than at the top of the page.
- **Entry points:** *New product* on the catalogue (S2) and *Edit product* on product detail (S3),
  both rendered only for a manager.

#### S8 — Review moderation (`/moderation`)

Reachable only when the session bootstrap reports `canModerate`; a visitor who types the URL gets
the same treatment as S7 — redirected, and refused server-side regardless.

- **Reads:** a paginated, newest-first list of reviews across every product (`reviews.moderationList`
  or equivalent — SPEC-0003), each row showing the product name and slug, the rating, title, body,
  author label, submitted date, and current state (`published` / `rejected`).
- **Filter:** a state filter defaulting to `published` — the working set a moderator reviews — with
  `rejected` available to check past decisions. Not a "queue": nothing feeds this list
  automatically in v1 (there is no reporting flow), so it is a browse-and-act surface over every
  review, not an inbox.
- **Actions:** *Reject* on a `published` row, *Restore* on a `rejected` row. Both are a single
  click with no confirmation dialog — unlike S5's delete, the action is reversible, which is the
  whole reason it does not need one. The row updates in place; no navigation.
- **States:** *loading* — row skeletons; *empty* — "No reviews yet" (true only before any review
  exists anywhere); *error* — the message-map copy with retry, scoped to the list.
- **Keyboard:** the filter is a native control; each action is a button with an accessible name
  that includes the product and review it acts on ("Reject review by A. Rivera on Sony WH-1000XM5"),
  never a bare "Reject" repeated down the list.
- **Entry point:** a link in the app's primary navigation, rendered only for a moderator — the same
  affordance pattern as S7's *New product*.

#### S6 — Not found and error boundary

The existing router error boundary (`apps/app/test/router-error-boundary.test.tsx`) extended with a
product-not-found case: a `NOT_FOUND` from `products.get` renders "This product doesn't exist"
with a link back to the catalogue, not the generic crash screen.

### Copy and the error surface

Every user-visible failure string comes from one message map keyed by `ErrorCode`
(`packages/kernel`'s `ERROR_CODE`), extended per screen where a code means something specific —
`CONFLICT` on the review form means "you already reviewed this", and nowhere else. A thrown error's
`message` is never rendered (ADR-0008): 5xx messages are replaced at the HTTP boundary anyway, so
rendering them shows users a generic string dressed as a specific one.

The codes a screen must handle: `VALIDATION`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
`RATE_LIMITED`, `PROVIDER`, `INTERNAL`, `MAGIC_LINK_SEND_FAILED`.

### Slice map

Under `apps/app/src/features/`, one folder per user-facing feature, no slice importing another
(ADR-0012, enforced by dependency-cruiser):

| Slice | Owns | Screens |
|---|---|---|
| `sign-in` (exists) | The magic-link request machine and screen | S1 |
| `catalogue` | Search/filter/sort state, the product card, the list query | S2 |
| `product-detail` | The product header, aggregate display, review list and paging | S3 |
| `review-submit` | The form, its draft persistence, submission and delete dialog | S4, S5 |
| `catalogue-authoring` | The product form, slug derivation preview, create and edit mutations | S7 |
| `moderation` | The review list, its state filter, and the reject/restore mutations | S8 |

In `shared/`, because two slices need them: the message map, the query keys
(`shared/query-keys`, derived from `apiQuery` — never hand-written literals), the API client
(`shared/api` — the only place `fetch` may appear), and the "rated N ago" formatter.

Reused from `packages/styles`: `Button`, `Card`, `CardContent`, `Input`, `Label`, `FieldError`,
`Spinner`, and the token files under `src/tokens/`. Added: the star rating control (above) and a
`Dialog` primitive wrapping Radix for S5. Both are vendored source, not a component-library
dependency (ADR-0012).

### Non-functional floors

- **Accessibility:** the e2e accessibility pass covers S2, S3, S4 and S8; the rating control is
  operable by keyboard alone and announces its value; every interactive element has an accessible
  name; focus is never lost after an action (submission focuses the new review, deletion focuses
  the list, a reject/restore keeps focus on the row so a moderator can act down the list without
  refinding their place).
- **Latency budget on a seeded catalogue:** catalogue and product-detail reads answer in under 200 ms
  server-side, which the projection is what makes possible (ADR-0014).
- **Aggregate staleness:** visible within seconds of a submission under normal operation; the number
  displayed is always labelled with its computed-at time, so correctness never depends on that.

### Deliberately not in v1

Each names the seam it would use, so "later" means "extend", not "rework":

| Not built | The seam it already has |
|---|---|
| Helpfulness votes ("was this helpful?") | Its own table keyed by review and voter, and its own projection — the aggregation pattern is already proven by `product_rating` |
| Verified-purchase badge | An orders context that does not exist; the badge is a column on the review, written by whatever proves the purchase |
| Review images | An object-store port in `@repo/contracts` with a deterministic stub (ADR-0005) |
| Seller replies | A second content table referencing the review; the same submission pipeline shape |
| Reporting and abuse handling | An event on the messaging bus; no synchronous path needed |
| Product deletion or retirement | A state column on the product row and a filtered read; the cascade SPEC-0002 already describes makes hard deletion the wrong default once a catalogue is real |
| Granting either capability from a screen | Both are set by seed or by hand (ADR-0018); an admin screen for it is a surface with its own authorization question |
| Reporting or flagging a review | An event on the messaging bus feeding the `pending` state ADR-0018 reserves and leaves unused; moderation today is browse-and-act, not an inbox |
| A moderation audit trail (who rejected what, when) | A `reviews.moderation_event` table keyed by review, actor and transition; the current state is enough to specify, a history is not |

## Open questions

1. **Author display name.** `auth.app_user` has no display name and `auth.identity.name` is
   better-auth's. Proposal: display a derived, stable label (the email's local part, truncated) and
   never the email itself; a real profile is a later addition. Needs a decision before S3 is built.
2. **Deletion semantics.** Hard delete is specified (rule 5). If reviews later need retention for
   moderation, that becomes a state transition rather than a `DELETE`, and the lifecycle registry
   entry changes with it (SPEC-0002).
3. **Review list ordering.** Newest first is specified. "Most helpful" needs votes, which are not in
   v1; a `sort` param on the review list is therefore deliberately absent rather than stubbed.
4. **Catalogue sort by rating.** Products with no reviews sort last under *Highest rated*; whether
   they sort last or are hidden is a product call, currently "last".
5. **Draft persistence.** `sessionStorage` per product token is proposed (J3). A server-side draft
   would survive a device change and needs a table; not proposed for v1.
6. **A rejected review, from its author's side.** Rule 11 removes it from the author's own-review
   lookup along with everyone else's — so an author who was moderated sees "Write a review" again,
   not an explanation. A softer answer (show it to the author only, marked rejected) reads kinder
   and costs a scoping decision this document has not made: whether "own review" is one query or two
   depending on who is asking. Deferred rather than guessed.
7. **Bulk moderation.** S8 acts one row at a time. A catalogue-sized review volume may want
   select-and-reject-many; not proposed until the one-at-a-time surface shows it is too slow.

## Traceability

| Part of this specification | Constrained by | Implemented by |
|---|---|---|
| Actors, session requirement, both capabilities | ADR-0018 | TASK-0003, TASK-0008, TASK-0009 |
| Domain objects, slug and SKU identity, review moderation state | ADR-0016, SPEC-0002 | TASK-0002, TASK-0008 |
| Rules 1–2, 6–8 (rating, uniqueness, edit/delete) | ADR-0016 | TASK-0002, TASK-0003 |
| Rules 3–4 (immutable address, who may author) | ADR-0016, ADR-0018 | TASK-0008 |
| Rules 5, 9–12 (ownership, moderation) | ADR-0018 | TASK-0009 |
| Rules 13–14 (staleness, no average) | ADR-0014 | TASK-0004, TASK-0005 |
| Rule 15 (anonymous reads, 401 writes) | ADR-0018, ADR-0008 | TASK-0003 |
| Journeys J1–J6 | ADR-0012 | TASK-0004, TASK-0008 |
| Journey J7 and screen S8 | ADR-0012, ADR-0018 | TASK-0009 |
| Screens S1–S6, slice map, primitives | ADR-0012 | TASK-0004 |
| Screen S7 and the `catalogue-authoring` slice | ADR-0012, ADR-0018 | TASK-0008 |
| Error surface and message map | ADR-0008 | TASK-0004 |
| Accessibility floors | ADR-0012, ADR-0010 | TASK-0004 |
| Seeded catalogue the screens assume | ADR-0005 | TASK-0006 |
