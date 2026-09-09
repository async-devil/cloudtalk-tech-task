/**
 * PROVENANCE
 * upstream: shadcn/ui — https://ui.shadcn.com/docs/components/input
 * pin: shadcn CLI 4.16.0
 * copied: 2026-07-29
 * changed: retokenised every upstream variable to this system's semantic tokens
 * (--input/--border -> --color-border; --background -> --color-surface-raised;
 * --foreground -> --color-content; --muted-foreground -> --color-content-muted;
 * --primary -> --color-accent for the selection colours; --destructive ->
 * --color-danger; --ring -> --color-focus-ring; rounded-md -> rounded-control;
 * text-base/md:text-sm -> text-body; px-3 -> px-(--size-control-inset);
 * shadow-xs -> shadow-raised); touch target raised h-9 (36px) -> min-h/min-w
 * --size-touch-target (44px), ADR-0012; upstream's focus-visible:ring-[3px]
 * replaced by this repo's outline-based ring (internal/interactive-base.ts);
 * upstream's `min-w-0` dropped because it silently overrode the floor's min-width
 * (see the note on the class list below); upstream `cn` import repointed at
 * @repo/styles and the upstream copy deleted; every `dark:` variant dropped — this
 * token set declares no dark theme.
 */
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../class-names.js';
import { INTERACTIVE_BASE_CLASSES } from '../internal/interactive-base.js';

/**
 * Text-input appearance. The invalid state is driven by the `aria-invalid` ATTRIBUTE rather than a
 * `variant` prop — upstream's choice, kept deliberately: the attribute is what assistive
 * technology reads, so binding the visual to it makes "looks wrong" and "is announced as wrong"
 * impossible to get out of step.
 */
export const inputVariants = cva([
  ...INTERACTIVE_BASE_CLASSES,
  // Upstream's `min-w-0` is DELIBERATELY not carried over: it is the same tailwind-merge group as
  // the floor's `min-w-(--size-touch-target)`, so it silently won and stripped the 44px minimum
  // width. Caught by `test/accessibility-defaults.test.tsx`, which is precisely the case
  // demands that test cover. Upstream wants it so an input can shrink inside a flex row; the
  // floor wins (ADR-0012), and a caller who genuinely needs shrinking passes `min-w-0`
  // explicitly and owns that decision.
  'flex w-full',
  'rounded-control border border-border bg-surface-raised text-content shadow-raised',
  'px-(--size-control-inset) py-1 text-body',
  'selection:bg-accent selection:text-accent-content',
  'placeholder:text-content-muted',
  'file:inline-flex file:border-0 file:bg-transparent file:text-body file:font-medium file:text-content',
  'aria-invalid:border-danger',
  'aria-invalid:focus-visible:outline-(--color-danger)',
]);

export type InputVariants = VariantProps<typeof inputVariants>;

export type InputProps = ComponentProps<'input'>;

/**
 * The text-input primitive, carrying this repo's accessibility floor by
 * default: a 44px minimum target on both axes and a visible `focus-visible` ring.
 */
export function Input({ className, type, ...rest }: InputProps) {
  return (
    <input type={type} data-slot="input" className={cn(inputVariants(), className)} {...rest} />
  );
}
