/**
 * PROVENANCE
 * upstream: none (authored in this repo)
 * pin: n/a
 * copied: n/a
 * changed: n/a — SPEC-0001 S4 names this control as "the one new primitive this specification
 * adds to `packages/styles`". shadcn/ui ships no rating control to vendor from, and no other
 * registered source (see `field-error.tsx`/`spinner.tsx` for the same honest `upstream: none`
 * category) contributes one either, so this is first-party.
 */

import type { KeyboardEvent } from 'react';
import { useRef, useState } from 'react';
import { cn } from '../class-names.js';

const STAR_VALUES = [1, 2, 3, 4, 5] as const;

/**
 * The five-star radio-group's own touch target and focus ring. NOT `INTERACTIVE_BASE_CLASSES`
 * (`internal/interactive-base.ts`): that file's `focus-visible:` variants target the element they
 * are applied to, but the focusable element here is the visually-hidden `<input>` — the ring has
 * to paint on the *label* beside it, which needs the `peer-focus-visible:` form of the same
 * tokens. Spelled out literally (not derived from `INTERACTIVE_BASE_CLASSES` at runtime) because
 * Tailwind v4 generates CSS by scanning literal class strings in source; a computed `.replace()`
 * would produce a class name Tailwind never saw and never generated a rule for.
 */
const STAR_TOUCH_TARGET_CLASSES = ['min-h-(--size-touch-target)', 'min-w-(--size-touch-target)'];
const STAR_FOCUS_RING_CLASSES = [
  'peer-focus-visible:outline-2',
  'peer-focus-visible:outline-offset-2',
  'peer-focus-visible:outline-(--color-focus-ring)',
];

/** One accessible group name, required — the `Spinner` primitive's `label` prop carries the same
 * non-negotiable shape (packages/styles has no workspace edges, so copy resolution is the
 * caller's job; this control only decides WHICH prop carries it). Exactly one of the two is
 * required at the type level so a caller cannot ship a radiogroup with no accessible name. */
type StarRatingLabelProps =
  | { readonly 'aria-label': string; readonly 'aria-labelledby'?: undefined }
  | { readonly 'aria-labelledby': string; readonly 'aria-label'?: undefined };

export type StarRatingProps = StarRatingLabelProps & {
  /** The committed rating, or `undefined` when nothing has been chosen yet — mirrors SPEC-0001
   * rule 14 (no rating is a real, renderable state, not a 0). */
  readonly value: number | undefined;
  /** Fired only on a real selection: a click, `Space`/`Enter`, or an arrow-key move that lands on
   * a new star (see the note on "preview" below). Never fired by hover or by tabbing INTO the
   * group without moving further. */
  readonly onChange: (value: number) => void;
  /** The shared `name` for the five underlying `<input type="radio">` elements. Required, exactly
   * like a native radio group — two `StarRating`s on one page need two names or they fight over
   * the same selection. */
  readonly name: string;
  readonly disabled?: boolean;
  readonly className?: string;
};

/**
 * The rating control: a native `role="radiogroup"` of five real `<input type="radio">` elements
 * sharing one `name` (SPEC-0001 S4). Building it on real radios rather than five `role="radio"`
 * `<div>`s is what makes the keyboard contract "come largely free" — the browser already moves
 * focus AND selection together with the arrow keys and selects on `Space`/`Enter`, which is
 * exactly SPEC-0001's "arrow keys move... Space/Enter select". `Home`/`End` are the one part of
 * that contract native grouped radios do NOT implement, so a small keydown handler on the group
 * supplies just those two.
 *
 * DECISION WORTH FLAGGING (native radios and "preview without committing" pull in different
 * directions, and this is the resolution): mouse HOVER previews cleanly — hovering a star that is
 * not focused or checked changes nothing at the DOM level, so `previewValue` can drive the visual
 * fill with zero interference from `checked`/`onChange`. Keyboard focus is a different case: a
 * native radio group SELECTS as focus moves (that is the platform behaviour SPEC-0001 asks this
 * control to keep "largely free"), so for a keyboard user "the star currently previewed" and "the
 * star currently committed" are the same star the instant an arrow key lands — there is no
 * keyboard state where they diverge. Getting genuine keyboard preview-without-commit would mean
 * abandoning native `<input type="radio">` for a manual-activation `role="radio"` pattern (roving
 * `tabIndex`, hand-rolled focus management) — the exact complexity using real radios exists to
 * avoid. `previewValue` is still wired to each star's `onFocus`, so this stays correct (and
 * matches the committed value) rather than becoming dead state.
 */
export function StarRating({
  value,
  onChange,
  name,
  disabled = false,
  className,
  ...labelProps
}: StarRatingProps) {
  const [previewValue, setPreviewValue] = useState<number | undefined>(undefined);
  const inputRefs = useRef<Array<HTMLInputElement | null>>([]);
  const displayValue = previewValue ?? value ?? 0;

  function commit(next: number): void {
    if (disabled) {
      return;
    }
    onChange(next);
  }

  function focusStar(oneBasedValue: number): void {
    inputRefs.current[oneBasedValue - 1]?.focus();
  }

  /** `Home`/`End`: the one part of the native grouped-radio keyboard contract the browser does
   * not supply on its own (SPEC-0001 S4). Both keys otherwise scroll the page, hence
   * `preventDefault`. */
  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
    if (disabled) {
      return;
    }
    if (event.key === 'Home') {
      event.preventDefault();
      commit(1);
      focusStar(1);
    } else if (event.key === 'End') {
      event.preventDefault();
      commit(5);
      focusStar(5);
    }
  }

  return (
    <div
      role="radiogroup"
      aria-label={labelProps['aria-label']}
      aria-labelledby={labelProps['aria-labelledby']}
      className={cn('inline-flex items-center gap-1', className)}
      onKeyDown={handleKeyDown}
      onMouseLeave={() => setPreviewValue(undefined)}
    >
      {STAR_VALUES.map((starValue) => (
        <label
          key={starValue}
          className={cn(
            'relative inline-flex cursor-pointer items-center justify-center rounded-control',
            ...STAR_TOUCH_TARGET_CLASSES,
            ...STAR_FOCUS_RING_CLASSES,
            disabled && 'cursor-not-allowed opacity-60',
          )}
          onMouseEnter={() => {
            if (!disabled) {
              setPreviewValue(starValue);
            }
          }}
        >
          <input
            ref={(element) => {
              inputRefs.current[starValue - 1] = element;
            }}
            type="radio"
            name={name}
            value={starValue}
            checked={value === starValue}
            disabled={disabled}
            className="peer sr-only"
            aria-label={`${starValue} star${starValue === 1 ? '' : 's'}`}
            onChange={() => commit(starValue)}
            onFocus={() => setPreviewValue(starValue)}
            onBlur={() => setPreviewValue(undefined)}
          />
          <StarGlyph filled={starValue <= displayValue} />
        </label>
      ))}
      {/* `aria-live="polite"` over `aria-valuetext`: `aria-valuetext` is defined for `slider` /
       * `spinbutton` / `progressbar` roles, none of which this control carries (it IS a
       * `radiogroup` of five distinct, individually-labelled options, not one widget with a
       * numeric range) — repurposing it here would be announcing a value the accessibility tree
       * has no role contract for. A visually-hidden polite live region announcing the committed
       * value is understood uniformly across screen readers for exactly this "discrete choice
       * changed" shape, which is the value SPEC-0001 S4 asks the group to announce. */}
      <span aria-live="polite" className="sr-only">
        {value === undefined ? 'No rating selected' : `${value} of 5 stars`}
      </span>
    </div>
  );
}

/** A single five-point star glyph. `aria-hidden`: every star's accessible name comes from its
 * `<input>`'s own `aria-label` above, so the glyph itself must stay invisible to assistive tech —
 * otherwise a screen reader would read the SVG twice. */
function StarGlyph({ filled }: { readonly filled: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className={cn('size-5', filled ? 'fill-accent text-accent' : 'fill-none text-content-muted')}
    >
      <path
        d="M12 2.5 15.09 8.76 22 9.77 17 14.64 18.18 21.52 12 18.26 5.82 21.52 7 14.64 2 9.77 8.91 8.76 12 2.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
    </svg>
  );
}
