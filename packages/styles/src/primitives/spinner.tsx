/**
 * PROVENANCE
 * upstream: none (authored in this repo)
 * pin: n/a
 * copied: n/a
 * changed: shadcn/ui ships no spinner at all, and smoothui — the registered motion source —
 * contributes nothing to under no-speculative-vendoring ruling (adopting
 * it would pull in `motion` for one keyframe). So this stays first-party under the
 * `upstream: none` header form, which exists so nobody invents a pin.
 */
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../class-names.js';

/**
 * Spinner appearance, CVA-only.
 *
 * `motion-safe:animate-spin` rather than a bare `animate-spin`: a keyframe animation has no
 * duration token to collapse, so `tokens/motion.css`'s reduced-motion gate cannot reach it — this is the
 * one place the variant has to be spelled at the call site. Under `prefers-reduced-motion: reduce`
 * the element renders as a static ring rather than disappearing, so the "busy" affordance
 * survives.
 */
export const spinnerVariants = cva(
  [
    'inline-block rounded-pill align-middle',
    'border-2 border-border border-t-accent',
    'motion-safe:animate-spin',
  ],
  {
    variants: {
      size: {
        inline: 'size-4',
        standalone: 'size-8',
      },
    },
    defaultVariants: {
      size: 'inline',
    },
  },
);

export type SpinnerVariants = VariantProps<typeof spinnerVariants>;

export type SpinnerProps = Omit<ComponentPropsWithoutRef<'span'>, 'children'> &
  SpinnerVariants & {
    /**
     * The accessible name announced while the spinner is on screen. REQUIRED, and a plain string
     * rather than a message id: `packages/styles` has no workspace edges, so the
     * caller resolves the copy through `@repo/i18n` and passes the result down.
     */
    readonly label: string;
  };

/**
 * The one busy-indicator primitive. `role="status"` plus a visually-hidden label
 * means a screen reader announces the wait; a spinner with no accessible name is invisible to it.
 */
export function Spinner({ className, size, label, ...rest }: SpinnerProps) {
  return (
    <span role="status" className={cn('inline-flex items-center', className)} {...rest}>
      <span aria-hidden="true" className={spinnerVariants({ size })} />
      <span className="sr-only">{label}</span>
    </span>
  );
}
