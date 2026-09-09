# @repo/styles

The design system: a token layer, a `cn` class merger, and six vendored primitives. It is the only
place in this repository that decides what a colour, a radius, a spacing step or a duration is.
Products compose primitives; they do not reach past them.

**When NOT to use this.** It holds no product concepts. A `ProductCard` or a `StarRating` belongs to
the feature slice that owns it (ADR-0012), built out of these primitives. If you find yourself
adding a component here because two features need it, that is a `shared/` component in the app, not
a design-system primitive — a primitive is a thing with no opinion about this product.

**Primitives are vendored, not written.** Each is copied from an upstream at a recorded pin,
retokenised onto this system's semantic tokens, and reviewed like any other source here. Every file
in `src/primitives/` opens with a provenance header naming its upstream and pin, or `upstream: none`
where this repository genuinely authored it. Upstream is a starting point, never an authority: where
it disagrees with this repository's accessibility floor, the floor wins, and the divergence is named
in the header. Radix stops here — no app and no other module may import it, and a boundary rule
enforces that.

**This package ships source.** It is the named exception to ADR-0001's one-built-entry rule:
`package.json`'s `exports` map points at `src/`, not `dist/`. Two structural reasons. Tailwind v4
has to *scan* the class strings the primitives emit in order to generate CSS for them, and the
stylesheet has to reach the consumer's Tailwind pipeline as CSS rather than as a build artifact.
`tsc` still builds `dist/`, which is what keeps the type surface and the extraction proof honest —
`styles` extracts build-only for exactly this reason.

## Public contract

| Export | What it is |
|---|---|
| `cn(...)` | The class merger: `clsx` semantics plus token-group-aware conflict resolution |
| `Button`, `ButtonProps`, `ButtonVariants`, `buttonVariants` | Button primitive and its variant surface |
| `Card`, `CardHeader`, `CardTitle`, `CardDescription`, `CardContent`, `CardFooter` | Surface container and its parts |
| `Input`, `InputProps`, `InputVariants`, `inputVariants` | Text input primitive |
| `Label`, `LabelProps`, `labelVariants` | Control label, bound through `htmlFor` |
| `FieldError`, `FieldErrorProps`, `fieldErrorVariants` | Validation message with `role="alert"` |
| `Spinner`, `SpinnerProps`, `spinnerVariants` | Busy indicator with `role="status"` |
| `@repo/styles/styles.css` | The stylesheet entry — a separate registered export |

The stylesheet is a second entry point because `tsc` neither reads nor emits CSS, so no JavaScript
barrel could ever expose it. It is registered in the module registry as a sanctioned subpath.

## Dependencies

| Dependency | Why |
|---|---|
| `@radix-ui/react-slot`, `@radix-ui/react-label` | Behaviour under the primitives — focus management, ARIA wiring, polymorphic rendering. The hard parts, which are not worth re-authoring. |
| `class-variance-authority` | The variant surface each primitive exposes |
| `clsx`, `tailwind-merge` | What `cn` is built from |
| `react` (peer) | The primitives are React components |

No workspace dependencies. It is a leaf on the module graph in the same way `kernel` is.

## Config slice

None.

## Named invariants

- **INV-1:** `cn` drops the losing utility when two classes target the same group, including this
  system's own token groups — two radius tokens, two type-scale tokens, two elevation tokens, two
  colours on one property, and a custom easing against a built-in one all collapse correctly
  (→ `test/class-names.test.ts::treats two radius tokens as one group`, and the five cases beside it).
- **INV-2:** a caller's `className` can override a primitive's default for the same utility group,
  and utilities from different groups both survive
  (→ `test/primitives.test.tsx::lets a caller className override a primitive default for the same utility group`).
- **INV-3:** `Button` and `Input` carry the touch-target floor and the focus ring with no props at
  all — the floor is a default, not an opt-in
  (→ `test/accessibility-defaults.test.tsx::gives Button the touch-target floor and focus ring with no props at all`).
- **INV-4:** the focus ring paints on `:focus-visible` only, never on plain `:focus`, so a mouse
  click does not leave a ring behind
  (→ `test/accessibility-defaults.test.tsx::paints the ring on focus-visible only, never on plain:focus`).
- **INV-5:** no type-scale token is below 0.6875rem (11px), and the scale stays in `rem` so the
  floor is checkable at all
  (→ `test/design-tokens.test.ts::has no type-scale token below 11px`).
- **INV-6:** the touch-target token is at least 44px
  (→ `test/design-tokens.test.ts::sets the touch-target token to at least 44px`).
- **INV-7:** every `--duration-*` token collapses to `0ms` under `prefers-reduced-motion: reduce`,
  and none is already `0ms` outside that block — which would make the check pass while proving
  nothing. Derived from the declared tokens, so adding a fourth duration without gating it turns
  the test red
  (→ `test/design-tokens.test.ts::collapses every duration token to 0ms under prefers-reduced-motion`
  and `::declares no motion duration that is already zero outside the gate`).
- **INV-8:** every token is named for its ROLE, never for a hue — `--color-accent`, not
  `--color-blue`, because the second name is a lie the first time the theme changes
  (→ `test/design-tokens.test.ts::names every token for its ROLE, never for a hue`).
- **INV-9:** every safe-area inset declares an explicit `0px` fallback, and no Tailwind token is
  registered that no `:root` block gives a value
  (→ `test/design-tokens.test.ts::declares every safe-area inset with an explicit 0px fallback`
  and `::registers no Tailwind token that no:root block gives a value`).
- **INV-10:** `base.css` stays a consumer — it references tokens and declares none, so there is one
  place a token is born
  (→ `test/design-tokens.test.ts::keeps base.css a consumer: it references tokens and declares none`).
- **INV-11:** the token-manifest is generated from the token CSS and its freshness is checked, so
  the manifest cannot drift from the stylesheet (→ `scripts/check-token-manifest.ts`).

The first assertion in the token suite is that the tokens parse to something non-empty at all. It
looks redundant beside the rules above and is not: every one of them is a search over parsed
declarations, and a parser silently reading an empty file makes all of them pass.

## Telemetry

None. This module emits no spans and declares no instruments — it is a rendering layer with no
behaviour worth tracing.

## Extraction

```
bun run extract-module styles
```

Reports `pass (build-only)`. This module ships source rather than a build, so the extraction proof
compiles it and does not run a consumer's bundler against it — recorded rather than silent, because
an extraction that skipped its tests must never read as a plain pass.
