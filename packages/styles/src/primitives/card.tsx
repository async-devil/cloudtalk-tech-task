/**
 * PROVENANCE
 * upstream: shadcn/ui — https://ui.shadcn.com/docs/components/card
 * pin: shadcn CLI 4.16.0
 * copied: 2026-07-29
 * changed: retokenised (--card/--card-foreground -> --color-surface-raised/--color-content;
 * --border -> --color-border; --muted-foreground -> --color-content-muted;
 * rounded-xl -> rounded-surface; shadow-sm -> shadow-raised; text-sm -> text-caption
 * on CardDescription; upstream's bare px-6/py-6 -> the --size-control-inset token so
 * the card's padding re-brands with everything else); upstream `cn` import repointed
 * at @repo/styles and the upstream copy deleted; this system's first-party `elevation`
 * variant REMOVED in favour of upstream's single flat surface (keeps upstream's
 * vocabulary; no call site used it); `@container/card-header` dropped from CardHeader
 * — it exists upstream to drive container queries this system declares no tokens for,
 * and an unused container context is dead weight on every card.
 */
import { cva } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../class-names.js';

/**
 * Card appearance — a surface, and nothing else. NON-INTERACTIVE by design: a clickable card is a
 * `Button` (or a `Button asChild` wrapping a link) around the content, so the focus ring and the
 * touch target come from the primitive that actually takes focus. A `<div onClick>` is invisible
 * to a keyboard, and making that easy is how a design system leaks inaccessible UI.
 */
export const cardVariants = cva([
  'flex flex-col gap-6',
  'rounded-surface border border-border bg-surface-raised text-content shadow-raised',
  'py-(--size-control-inset)',
]);

export type CardProps = ComponentProps<'div'>;

/** The surface container. */
export function Card({ className, ...rest }: CardProps) {
  return <div data-slot="card" className={cn(cardVariants(), className)} {...rest} />;
}

/**
 * The sub-components below arrive as part of upstream's single `card` component and are kept
 * together deliberately: dropping the ones without a consumer today would be a divergence to
 * re-apply on every future re-copy, and re-copy is how an upstream fix reaches us. They are
 * pure layout wrappers — no dependency, no behaviour, no variant surface.
 */
export function CardHeader({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-header"
      className={cn(
        'grid auto-rows-min items-start gap-2 px-(--size-control-inset) [.border-b]:pb-6',
        className,
      )}
      {...rest}
    />
  );
}

export function CardTitle({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-title"
      className={cn('text-title leading-none font-semibold', className)}
      {...rest}
    />
  );
}

export function CardDescription({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-description"
      className={cn('text-caption text-content-muted', className)}
      {...rest}
    />
  );
}

export function CardContent({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-content"
      className={cn('px-(--size-control-inset)', className)}
      {...rest}
    />
  );
}

export function CardFooter({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="card-footer"
      className={cn('flex items-center px-(--size-control-inset) [.border-t]:pt-6', className)}
      {...rest}
    />
  );
}
