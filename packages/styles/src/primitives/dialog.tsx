/**
 * PROVENANCE
 * upstream: shadcn/ui — https://ui.shadcn.com/docs/components/dialog
 * pin: shadcn CLI 4.16.0
 * copied: 2026-09-10
 * changed: retokenised (bg-background -> --color-surface-raised; bare `border` ->
 * `border border-border`; rounded-lg (the content panel) -> rounded-surface, the same
 * "elevated panel" token `card.tsx` uses, chosen over rounded-control because a dialog is a
 * surface, not a control; rounded-xs (the corner close button) is gone entirely — see below;
 * shadow-lg -> shadow-overlay (NOT shadow-raised: this token set gives floating/overlay
 * chrome its own token, colors.css's `--shadow-overlay`, distinct from a resting card's
 * `--shadow-raised`, and a modal is exactly the overlay case); text-lg -> text-title
 * (DialogTitle, matching card.tsx's CardTitle); text-sm text-muted-foreground ->
 * text-caption text-content-muted (DialogDescription, matching CardDescription);
 * bg-black/50 (the overlay scrim) -> bg-content/50, the nearest semantic token this system
 * declares for "near-black, translucent" (`--color-content` is oklch(22% 0 0)) — there is no
 * dedicated scrim token, and inventing one for a single consumer was judged not worth a new
 * row in tokens/colors.css); upstream `cn` import repointed at @repo/styles;
 * `import { Dialog as DialogPrimitive } from "radix-ui"` rewritten to the
 * individually-versioned @radix-ui/react-dialog the registry pins (the same rewrite
 * label.tsx documents for its own Radix import); the `"use client"` directive dropped —
 * this is a Vite SPA, not an RSC app (matches label.tsx); every
 * `data-[state=]:animate-in`/`fade-in-0`/`zoom-in-95` motion-utility class dropped and
 * replaced with this system's own token-gated transition (`transition-all`,
 * `duration-(--duration-fast)`, opacity/scale pairs keyed off `data-[state=]`) — those
 * upstream classes come from the `tw-animate-css` plugin, which is not registered in this
 * workspace (Tailwind v4 core only), so as literal text they would compile to nothing;
 * `role="alertdialog"` is NOT set anywhere here — Radix's `Root` defaults `Content` to
 * `role="dialog"`, which is what every consumer of this primitive needs (SPEC-0001 S5's
 * delete confirmation is a `dialog`, not an `alertdialog`), and this file does not expose the
 * distinction as its own prop since nothing in this specification uses it;
 * upstream's built-in close button used lucide-react's `XIcon` — not a registered
 * dependency here (`spinner.tsx` documents the same no-speculative-icon-dependency stance) —
 * so it is replaced by a small first-party inline SVG glyph, and the button itself is now
 * this system's own `Button` primitive (`variant="ghost" size="icon-xs"`) rather than a raw
 * `<button>` with upstream's hand-rolled `focus:ring-2`/`ring-ring`/`ring-offset` treatment:
 * `Button` already carries the 44px touch-target floor and the outline-based
 * `focus-visible` ring (ADR-0012), so composing it here means that floor is proven once, in
 * `button.tsx`'s own tests, rather than re-implemented and re-asserted a second time.
 */
// Radix supplies the behavioural layer no other primitive in this system needs: a real focus
// trap, a portal, and Escape-to-dismiss with focus returned to the trigger (SPEC-0001 S5). Every
// other primitive here is presentational CSS over a plain DOM element; a dialog is the one place
// "behaviour is the hard part" (ADR-0012), which is what earns Radix's runtime cost.
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ComponentProps } from 'react';
import { cn } from '../class-names.js';
import { Button } from './button.js';

export type DialogProps = ComponentProps<typeof DialogPrimitive.Root>;

/** The dialog's open/close state machine — Radix's `Root`, which owns nothing visual. */
export function Dialog(props: DialogProps) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

export type DialogTriggerProps = ComponentProps<typeof DialogPrimitive.Trigger>;

/** The element that opens the dialog. Focus returns here on close — Radix's behaviour, not
 * something this wrapper has to implement (SPEC-0001 S5). */
export function DialogTrigger(props: DialogTriggerProps) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

/** The backdrop. Internal — always rendered by `DialogContent`, never reached past. */
function DialogOverlay({ className, ...rest }: ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn(
        'fixed inset-0 z-50 bg-content/50',
        'transition-opacity duration-(--duration-fast)',
        'data-[state=open]:opacity-100 data-[state=closed]:opacity-0',
        className,
      )}
      {...rest}
    />
  );
}

export type DialogContentProps = ComponentProps<typeof DialogPrimitive.Content> & {
  /** Hides the built-in corner close control for a dialog whose footer already supplies an
   * explicit dismiss action and wants exactly one way to close (defaults to `true`, matching
   * upstream). */
  readonly showCloseButton?: boolean;
};

/**
 * The dialog panel: portalled, backdrop behind it, focus-trapped inside it (Radix `Content`).
 * `Escape` dismisses and focus returns to the trigger — both are Radix behaviour, asserted in
 * `test/dialog.test.tsx` rather than re-implemented here.
 */
export function DialogContent({
  className,
  children,
  showCloseButton = true,
  ...rest
}: DialogContentProps) {
  return (
    <DialogPrimitive.Portal data-slot="dialog-portal">
      <DialogOverlay />
      <DialogPrimitive.Content
        data-slot="dialog-content"
        className={cn(
          'fixed top-1/2 left-1/2 z-50 grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4',
          'rounded-surface border border-border bg-surface-raised text-content shadow-overlay',
          'p-(--size-control-inset) outline-none',
          'transition-[opacity,transform] duration-(--duration-fast)',
          'data-[state=open]:scale-100 data-[state=open]:opacity-100',
          'data-[state=closed]:scale-95 data-[state=closed]:opacity-0',
          'sm:max-w-lg',
          className,
        )}
        {...rest}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute top-2 right-2"
              aria-label="Close"
            >
              <CloseGlyph />
            </Button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function DialogHeader({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-header"
      className={cn('flex flex-col gap-2 text-center sm:text-left', className)}
      {...rest}
    />
  );
}

export function DialogFooter({ className, ...rest }: ComponentProps<'div'>) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn('flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...rest}
    />
  );
}

export type DialogTitleProps = ComponentProps<typeof DialogPrimitive.Title>;

export function DialogTitle({ className, ...rest }: DialogTitleProps) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('text-title leading-none font-semibold', className)}
      {...rest}
    />
  );
}

export type DialogDescriptionProps = ComponentProps<typeof DialogPrimitive.Description>;

export function DialogDescription({ className, ...rest }: DialogDescriptionProps) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('text-caption text-content-muted', className)}
      {...rest}
    />
  );
}

export type DialogCloseProps = ComponentProps<typeof DialogPrimitive.Close>;

/** An unstyled close trigger for a caller-supplied action button — SPEC-0001 S5's own Cancel
 * button wraps this rather than tracking open state by hand. Composes with `asChild` exactly like
 * the corner close button above. */
export function DialogClose(props: DialogCloseProps) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

/** The corner close glyph. `aria-hidden`: the accessible name comes from the wrapping `Button`'s
 * `aria-label="Close"` above, matching `star-rating.tsx`'s glyph/label split. Not lucide-react —
 * see the PROVENANCE header. */
function CloseGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4">
      <path d="M6 6 18 18M18 6 6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}
