/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Regenerate with `moon run styles:token-manifest`; `styles:token-manifest-check` re-runs the
 * generator in CI and diffs, so an edit here is reverted by the next generation and fails the gate
 * in the meantime.
 *
 * Source: `src/tokens/*.css` (the `:root` blocks, where values live).
 * Generator: `scripts/generate-token-manifest.ts`.
 *
 * This is what ARMS the design-system adherence gate: the "undeclared token
 * reference" rule — no `var(--foo)` naming a token this system does not declare — is what makes
 * "retokenised" checkable instead of claimed, and it needs a machine-readable token set to exist
 * at all.
 */

/** Every design token this system declares, with its kind. */
export const TOKEN_MANIFEST = {
  '--color-accent': 'color',
  '--color-accent-content': 'color',
  '--color-accent-hover': 'color',
  '--color-border': 'color',
  '--color-border-strong': 'color',
  '--color-content': 'color',
  '--color-content-inverted': 'color',
  '--color-content-muted': 'color',
  '--color-danger': 'color',
  '--color-danger-content': 'color',
  '--color-danger-hover': 'color',
  '--color-danger-surface': 'color',
  '--color-focus-ring': 'color',
  '--color-success': 'color',
  '--color-surface': 'color',
  '--color-surface-raised': 'color',
  '--color-surface-sunken': 'color',
  '--color-warning': 'color',
  '--duration-fast': 'motion',
  '--duration-medium': 'motion',
  '--duration-slow': 'motion',
  '--ease-standard': 'motion',
  '--radius-control': 'radius',
  '--radius-pill': 'radius',
  '--radius-surface': 'radius',
  '--shadow-overlay': 'shadow',
  '--shadow-raised': 'shadow',
  '--size-control-inset': 'size',
  '--size-touch-target': 'size',
  '--spacing-safe-bottom': 'spacing',
  '--spacing-safe-left': 'spacing',
  '--spacing-safe-right': 'spacing',
  '--spacing-safe-top': 'spacing',
  '--text-body': 'text',
  '--text-body--line-height': 'text',
  '--text-caption': 'text',
  '--text-caption--line-height': 'text',
  '--text-display': 'text',
  '--text-display--line-height': 'text',
  '--text-title': 'text',
  '--text-title--line-height': 'text',
} as const;

export type TokenName = keyof typeof TOKEN_MANIFEST;
export type TokenKind = (typeof TOKEN_MANIFEST)[TokenName];

/** The token names as a list — the form the gate's lookups want. */
export const TOKEN_NAMES: readonly TokenName[] = Object.keys(TOKEN_MANIFEST) as TokenName[];
