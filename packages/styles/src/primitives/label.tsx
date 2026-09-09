/**
 * PROVENANCE
 * upstream: shadcn/ui — https://ui.shadcn.com/docs/components/label
 * pin: shadcn CLI 4.16.0
 * copied: 2026-07-29
 * changed: retokenised (text-sm -> text-body; added text-content, which upstream inherits from
 * its parent); `import { Label as LabelPrimitive } from "radix-ui"` rewritten to the
 * individually-versioned @radix-ui/react-label the registry pins; upstream `cn` import
 * repointed at @repo/styles and the upstream copy deleted; the `"use client"`
 * directive dropped — this is a Vite SPA, not a React Server Components app, and the
 * directive is meaningless noise here.
 */
import * as LabelPrimitive from '@radix-ui/react-label';
import { cva } from 'class-variance-authority';
import type { ComponentProps } from 'react';
import { cn } from '../class-names.js';

/**
 * Label appearance. NOT an interactive primitive: a `<label>` takes no focus of its own (it
 * forwards the click to its control), so it carries neither the focus ring nor the touch-target
 * floor — those belong to the control it names.
 *
 * The `peer-disabled:` / `group-data-[disabled=true]:` pairs are upstream's and are kept: they let
 * a label dim along with its control without the caller wiring anything.
 */
export const labelVariants = cva([
  'flex items-center gap-2',
  'text-body font-medium leading-none text-content',
  'select-none',
  'group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50',
  'peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
]);

export type LabelProps = ComponentProps<typeof LabelPrimitive.Root>;

/**
 * The label primitive.
 *
 * Radix's `Label` is used rather than a bare `<label>` for one concrete behaviour: it suppresses
 * text selection on double-click, which on a plain label selects the text instead of activating
 * the control. `htmlFor` is a plain label prop and remains the caller's responsibility — that
 * pairing is what the keyboard-only e2e assertions exercise.
 */
export function Label({ className, ...rest }: LabelProps) {
  return (
    <LabelPrimitive.Root data-slot="label" className={cn(labelVariants(), className)} {...rest} />
  );
}
