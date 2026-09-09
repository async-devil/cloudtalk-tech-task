/**
 * The binding accessibility floor every interactive primitive spends (ADR-0012).
 *
 * Structural on purpose: a feature author cannot "forget" the focus ring or the 44px target,
 * because they are baked into the primitive's base class list rather than left to per-feature
 * effort. Both tokens are read from `src/tokens/` through v4's CSS-variable shorthand, so a re-brand
 * moves them without touching this file.
 *
 * Not exported from the barrel: the primitive set is frozen, so there is no
 * sanctioned second consumer. `packages/styles/test/accessibility-defaults.test.tsx` asserts the
 * resulting class strings against literals spelled out independently of this module, so deleting a
 * class here goes red there rather than silently agreeing with itself.
 */

/** Minimum touch target on both axes — ADR-0012's 44px, expressed as `--size-touch-target`. */
export const TOUCH_TARGET_CLASSES: readonly string[] = [
  'min-h-(--size-touch-target)',
  'min-w-(--size-touch-target)',
];

/**
 * A visible keyboard focus ring. `focus-visible`, never `focus`: a mouse click must not paint a
 * ring, or authors start removing it. `outline`, never `ring`, so the indicator survives inside
 * `overflow-hidden` ancestors, and `outline-offset` keeps it legible on filled controls.
 */
export const FOCUS_RING_CLASSES: readonly string[] = [
  'focus-visible:outline-2',
  'focus-visible:outline-offset-2',
  'focus-visible:outline-(--color-focus-ring)',
];

/** Motion that respects the reduced-motion token gate (`tokens/motion.css`'s `--duration-*` override). */
export const TRANSITION_CLASSES: readonly string[] = [
  'transition-colors',
  'duration-(--duration-fast)',
  'ease-standard',
];

/** Every class an interactive primitive gets for free. */
export const INTERACTIVE_BASE_CLASSES: readonly string[] = [
  ...TOUCH_TARGET_CLASSES,
  ...FOCUS_RING_CLASSES,
  ...TRANSITION_CLASSES,
  'disabled:cursor-not-allowed',
  'disabled:opacity-60',
];
