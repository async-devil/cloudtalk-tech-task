import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';
import {
  COLOR_TOKEN_NAMES,
  EASE_TOKEN_NAMES,
  RADIUS_TOKEN_NAMES,
  SHADOW_TOKEN_NAMES,
  TEXT_TOKEN_NAMES,
} from './internal/token-scales.js';

/**
 * `tailwind-merge` taught about this design system's scales (see `internal/token-scales.ts` for
 * why an unextended merge silently mis-groups custom tokens).
 */
const mergeTailwindClasses = extendTailwindMerge({
  extend: {
    theme: {
      color: [...COLOR_TOKEN_NAMES],
      text: [...TEXT_TOKEN_NAMES],
      radius: [...RADIUS_TOKEN_NAMES],
      shadow: [...SHADOW_TOKEN_NAMES],
      ease: [...EASE_TOKEN_NAMES],
    },
  },
});

/**
 * Joins conditional class values and resolves Tailwind conflicts left-to-right, so a caller's
 * `className` always wins over a primitive's own default for the same utility group (`cn('p-2',
 * 'p-4')` is `'p-4'`, not both).
 *
 * This is the ONLY sanctioned way to combine classes in this repository's UI: a plain template
 * string leaves both conflicting utilities in the attribute and lets CSS source order — not the
 * caller — decide, which is the failure mode that makes "just override it" unreliable.
 */
export function cn(...inputs: readonly ClassValue[]): string {
  return mergeTailwindClasses(clsx(inputs));
}
