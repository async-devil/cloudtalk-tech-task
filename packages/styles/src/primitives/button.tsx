/**
 * PROVENANCE
 * upstream: shadcn/ui — https://ui.shadcn.com/docs/components/button
 * pin: shadcn CLI 4.16.0
 * copied: 2026-07-29
 * changed: retokenised every upstream variable to this system's semantic tokens
 * (--primary/--primary-foreground -> --color-accent/--color-accent-content;
 * --destructive -> --color-danger; --secondary -> --color-surface-raised;
 * --accent -> --color-surface-sunken, NOT --color-accent, see the note below;
 * --input/--border -> --color-border; --ring -> --color-focus-ring;
 * rounded-md -> rounded-control; text-sm -> text-body; shadow-xs -> shadow-raised);
 * touch target raised h-9/h-8/h-6/size-9 (36/32/24px) -> min-h/min-w
 * --size-touch-target (44px) on EVERY size, ADR-0012; upstream's
 * focus-visible:ring-[3px] replaced by this repo's outline-based ring
 * (internal/interactive-base.ts) so it survives an overflow-hidden ancestor;
 * upstream `cn` import repointed at @repo/styles and the upstream copy deleted;
 * `import { Slot } from "radix-ui"` rewritten to the individually-versioned
 * @radix-ui/react-slot the registry pins; every `dark:` variant dropped — this token
 * set declares no dark theme, and a brand adds one by adding token values, never by
 * editing a component.
 */
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../class-names.js';
import { INTERACTIVE_BASE_CLASSES } from '../internal/interactive-base.js';

/**
 * A NAME COLLISION WORTH KNOWING ABOUT, because it is the one retokenising mistake that produces
 * a plausible-looking wrong answer rather than a broken build: shadcn's `--accent` is a MUTED
 * HOVER SURFACE (what `ghost` and `outline` fill with on hover), while this system's
 * `--color-accent` is the BRAND colour. Mapping upstream `accent` onto our `accent` would paint
 * every ghost button's hover state solid brand blue and nothing would fail. Upstream's `--accent`
 * is therefore `--color-surface-sunken` here.
 */
export const buttonVariants = cva(
  [
    ...INTERACTIVE_BASE_CLASSES,
    'inline-flex shrink-0 items-center justify-center gap-2 whitespace-nowrap',
    'rounded-control font-medium',
    'cursor-pointer',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
    'aria-invalid:border-danger',
  ],
  {
    variants: {
      variant: {
        default: 'bg-accent text-accent-content hover:bg-accent-hover',
        destructive: 'bg-danger text-danger-content hover:bg-danger-hover',
        outline: 'border border-border bg-surface shadow-raised hover:bg-surface-sunken',
        secondary: 'bg-surface-raised text-content border border-border hover:bg-surface-sunken',
        ghost: 'hover:bg-surface-sunken hover:text-content',
        link: 'text-accent underline-offset-4 hover:underline',
      },
      /**
       * SIZE MOVES PADDING AND TYPE, NEVER THE TARGET. Upstream expresses each size as
       * a fixed `h-*`; every one of those is below this repo's 44px floor, so the heights are gone
       * and the floor from `INTERACTIVE_BASE_CLASSES` applies to all of them.
       *
       * The icon sizes keep their `size-*` as a MINIMUM glyph box while the floor supplies the hit
       * area — a visually small icon button with a 44px target is the correct mobile pattern, not
       * a contradiction.
       */
      size: {
        default: 'px-4 py-2 text-body has-[>svg]:px-3',
        xs: "gap-1 px-2 text-caption has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'gap-1.5 px-3 text-body has-[>svg]:px-2.5',
        lg: 'px-6 text-title has-[>svg]:px-4',
        icon: 'p-2',
        'icon-xs': "p-1 [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'p-1.5',
        'icon-lg': 'p-3',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
);

export type ButtonVariants = VariantProps<typeof buttonVariants>;

export type ButtonProps = ComponentProps<'button'> &
  ButtonVariants & {
    /** Render the child element instead of a `<button>`, keeping every class and prop. The escape
     * hatch for a router `<Link>` that must look like a button without nesting an anchor inside
     * one. */
    readonly asChild?: boolean;
  };

/**
 * The button primitive. Carries this repo's accessibility floor by
 * default — a 44px minimum target on both axes and a visible `focus-visible` ring — neither of
 * which a caller has to ask for, and neither of which any `size` can take away.
 *
 * `type` defaults to `'button'`, not the HTML default `'submit'`: a button dropped inside a form
 * that silently submits it is the single most common accidental-mutation bug in a React form.
 * This is a deliberate divergence from upstream, which passes `type` straight through.
 */
export function Button({ className, variant, size, type, asChild = false, ...rest }: ButtonProps) {
  const Component = asChild ? Slot : 'button';
  return (
    <Component
      data-slot="button"
      type={asChild ? type : (type ?? 'button')}
      className={cn(buttonVariants({ variant, size }), className)}
      {...rest}
    />
  );
}
