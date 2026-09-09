/**
 * PROVENANCE
 * upstream: none (authored in this repo)
 * pin: n/a
 * copied: n/a
 * changed: shadcn's nearest equivalent is `FormMessage`, which is bound to react-hook-form —
 * not a registered dependency here, and froze a `useReducer` form
 * machine, so the upstream is unusable by CONSTRUCTION rather than by preference
 *. The `upstream: none` header form exists so nobody invents a pin for a file
 * that never had one.
 */
import { cva } from 'class-variance-authority';
import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../class-names.js';

/**
 * Field-error appearance. `text-caption` is the SMALLEST token in the scale (0.6875rem = 11px,
 * `tokens/typography.css`'s binding floor) — error text is exactly the copy a design is most tempted to
 * shrink, and the scale simply offers nothing smaller.
 */
export const fieldErrorVariants = cva(['text-caption', 'text-danger']);

export type FieldErrorProps = ComponentPropsWithoutRef<'p'>;

/**
 * The one field-error primitive.
 *
 * `role="alert"` by default: a validation message that appears after a failed submit must be
 * announced, and a caller who has to remember to add the role is a caller who will not. A caller
 * rendering a persistent hint rather than a reaction can override `role` through `...rest`.
 */
export function FieldError({ className, role, ...rest }: FieldErrorProps) {
  return <p role={role ?? 'alert'} className={cn(fieldErrorVariants(), className)} {...rest} />;
}
