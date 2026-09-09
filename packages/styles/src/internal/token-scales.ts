/**
 * The token names declared in `src/tokens/*.css`, restated as TypeScript so `tailwind-merge` can be told
 * about them.
 *
 * WHY THIS FILE HAS TO EXIST: `tailwind-merge` resolves conflicts from a static class map built at
 * import time. It cannot read the token CSS, so a custom scale it has never heard of falls through
 * to whichever built-in group happens to accept the string — `text-body` lands in `text-color`
 * (whose default validator accepts anything) rather than in `font-size`, and `cn('text-caption',
 * 'text-danger')` then drops the SIZE while keeping the colour. Silent, and exactly the class of
 * defect a "looks fine" screenshot never catches.
 *
 * THE DRIFT THIS CREATES IS GATED: `test/design-tokens.test.ts` parses `src/tokens/*.css` and reconciles it
 * against these lists in BOTH directions, so adding a token to the stylesheet without adding it
 * here (or the reverse) is a red build, not a subtle merge bug months later.
 */

/** `--color-*` — drives `bg-*`, `text-*`, `border-*`, `outline-*`, … */
export const COLOR_TOKEN_NAMES = [
  'surface',
  'surface-raised',
  'surface-sunken',
  'content',
  'content-muted',
  'content-inverted',
  'border',
  'border-strong',
  'accent',
  'accent-hover',
  'accent-content',
  'danger',
  'danger-hover',
  'danger-content',
  'danger-surface',
  'success',
  'warning',
  'focus-ring',
] as const;

/** `--text-*` — the type scale (`text-body`, `text-caption`, …). */
export const TEXT_TOKEN_NAMES = ['caption', 'body', 'title', 'display'] as const;

/** `--radius-*` — corner radii (`rounded-control`, …). */
export const RADIUS_TOKEN_NAMES = ['control', 'surface', 'pill'] as const;

/** `--shadow-*` — elevation (`shadow-raised`, …). */
export const SHADOW_TOKEN_NAMES = ['raised', 'overlay'] as const;

/** `--ease-*` — easing curves (`ease-standard`). */
export const EASE_TOKEN_NAMES = ['standard'] as const;
