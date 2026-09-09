import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button, type ButtonVariants } from '../src/primitives/button.js';
import { Input } from '../src/primitives/input.js';

afterEach(cleanup);

/**
 * The class literals are spelled out HERE rather than imported from
 * `src/internal/interactive-base.ts` on purpose: a test that asserts "the primitive uses the
 * shared const" passes just as happily when the const is emptied. These strings are an
 * independent statement of what ADR-0012 requires to be in the markup.
 */
const TOUCH_TARGET_CLASSES = [
  'min-h-(--size-touch-target)',
  'min-w-(--size-touch-target)',
] as const;
const FOCUS_RING_CLASSES = [
  'focus-visible:outline-2',
  'focus-visible:outline-offset-2',
  'focus-visible:outline-(--color-focus-ring)',
] as const;

/**
 * Upstream shadcn's variant vocabulary, kept rather than renamed (ruling): every
 * divergence is a rename to repeat on the next re-copy, and re-copy is how an upstream fix
 * reaches us.
 *
 * `satisfies` is doing real work here — it makes this list a COMPILE error if a variant is ever
 * added to the union without being added to the floor's coverage, which is the way a new size
 * would otherwise slip past the assertion below unproven.
 */
const BUTTON_VARIANTS = [
  'default',
  'destructive',
  'outline',
  'secondary',
  'ghost',
  'link',
] as const satisfies readonly NonNullable<ButtonVariants['variant']>[];
const BUTTON_SIZES = [
  'default',
  'xs',
  'sm',
  'lg',
  'icon',
  'icon-xs',
  'icon-sm',
  'icon-lg',
] as const satisfies readonly NonNullable<ButtonVariants['size']>[];

/**
 * / — "interactive primitives have min 44px touch targets and visible
 * `focus-visible` rings BY DEFAULT IN THE PRIMITIVE". Asserted on the rendered element's class
 * attribute (not on the CVA function's return value), so a primitive that computes the variants
 * and then forgets to apply them still fails.
 */
describe('binding accessibility defaults', () => {
  it('gives Button the touch-target floor and focus ring with no props at all', () => {
    render(<Button>Default</Button>);
    const className = screen.getByRole('button', { name: 'Default' }).className;
    for (const required of [...TOUCH_TARGET_CLASSES, ...FOCUS_RING_CLASSES]) {
      expect(className, `Button default is missing "${required}"`).toContain(required);
    }
  });

  /**
   * EVERY variant combination — 48 of them, not a sampled few ("for every variant
   * combination"). The floor is only a floor if no combination can drop below it, and `size` is
   * exactly where that would happen: upstream expresses each size as a fixed `h-*` BELOW our
   * minimum (h-6/h-8/h-9/h-10, i.e. 24–40px against 44px), so re-copying a size without stripping
   * its height is the specific regression this matrix catches.
   */
  it.each(
    BUTTON_VARIANTS.flatMap((variant) => BUTTON_SIZES.map((size) => ({ variant, size }))),
  )('keeps the floor for every variant combination (variant=$variant size=$size)', ({
    variant,
    size,
  }) => {
    render(
      <Button variant={variant} size={size}>
        Variant
      </Button>,
    );
    const className = screen.getByRole('button', { name: 'Variant' }).className;
    for (const required of [...TOUCH_TARGET_CLASSES, ...FOCUS_RING_CLASSES]) {
      expect(className, `variant=${variant} size=${size} is missing "${required}"`).toContain(
        required,
      );
    }
  });

  /**
   * The floor's other half, and the one a class-string assertion alone would miss: no size may
   * reintroduce a fixed height, because `h-9` and `min-h-(--size-touch-target)` are different
   * utility groups — tailwind-merge would keep BOTH, the shorter `h-*` would win in the cascade,
   * and every assertion above would still pass while the button rendered at 36px.
   */
  it.each(BUTTON_SIZES)('never reintroduces a fixed height for size=%s', (size) => {
    render(<Button size={size}>Sized</Button>);
    const className = screen.getByRole('button', { name: 'Sized' }).className;
    expect(className, `size=${size} carries a fixed height, which defeats the floor`).not.toMatch(
      /(?:^|\s)h-\d/,
    );
    expect(className, `size=${size} carries a fixed size-*, which defeats the floor`).not.toMatch(
      /(?:^|\s)size-\d/,
    );
  });

  it('gives Input the touch-target floor and focus ring with no props at all', () => {
    render(<Input aria-label="Field" />);
    const className = screen.getByLabelText('Field').className;
    for (const required of [...TOUCH_TARGET_CLASSES, ...FOCUS_RING_CLASSES]) {
      expect(className, `Input default is missing "${required}"`).toContain(required);
    }
  });

  it('survives a caller className that touches unrelated utilities', () => {
    // tailwind-merge groups by utility, so an unrelated override must not strip the floor.
    render(<Button className="bg-surface-sunken uppercase">Overridden</Button>);
    const className = screen.getByRole('button', { name: 'Overridden' }).className;
    for (const required of [...TOUCH_TARGET_CLASSES, ...FOCUS_RING_CLASSES]) {
      expect(className, `override stripped "${required}"`).toContain(required);
    }
  });

  it('paints the ring on focus-visible only, never on plain :focus', () => {
    // A `focus:` ring appears on mouse clicks too, which is exactly why authors start deleting it.
    render(<Button>Keyboard</Button>);
    const className = screen.getByRole('button', { name: 'Keyboard' }).className;
    expect(className).not.toMatch(/(?:^|\s)focus:outline/);
  });
});
