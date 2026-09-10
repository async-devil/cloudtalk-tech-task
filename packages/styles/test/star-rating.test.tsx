import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StarRating } from '../src/primitives/star-rating.js';

afterEach(cleanup);

/** A controlled wrapper — `StarRating` takes `value`/`onChange` like every other controlled
 * primitive in this system, so the tests exercise it exactly as a real form would. */
function ControlledStarRating({
  initial,
  onChange,
  disabled = false,
}: {
  readonly initial: number | undefined;
  readonly onChange?: (value: number) => void;
  readonly disabled?: boolean;
}) {
  const [value, setValue] = useState(initial);
  return (
    <StarRating
      name="rating"
      aria-label="Your rating"
      value={value}
      disabled={disabled}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

function starInput(n: number): HTMLInputElement {
  return screen.getByRole('radio', { name: `${n} star${n === 1 ? '' : 's'}` }) as HTMLInputElement;
}

describe('StarRating', () => {
  it('renders a labelled radiogroup of five radios, one per star', () => {
    render(<ControlledStarRating initial={undefined} />);
    const group = screen.getByRole('radiogroup', { name: 'Your rating' });
    const radios = screen.getAllByRole('radio');
    expect(radios).toHaveLength(5);
    expect(group.contains(radios[0] ?? null)).toBe(true);
  });

  it('shares one `name` across all five radios', () => {
    render(<ControlledStarRating initial={undefined} />);
    for (const n of [1, 2, 3, 4, 5]) {
      expect(starInput(n).name).toBe('rating');
    }
  });

  it('checks the star matching the committed value and no other', () => {
    render(<ControlledStarRating initial={3} />);
    expect(starInput(3).checked).toBe(true);
    for (const n of [1, 2, 4, 5]) {
      expect(starInput(n).checked).toBe(false);
    }
  });

  it('selecting a star commits it: calls onChange and checks the radio', () => {
    const onChange = vi.fn();
    render(<ControlledStarRating initial={undefined} onChange={onChange} />);
    fireEvent.click(starInput(4));
    expect(onChange).toHaveBeenCalledExactlyOnceWith(4);
    expect(starInput(4).checked).toBe(true);
  });

  it('a disabled group commits nothing on click', () => {
    const onChange = vi.fn();
    render(<ControlledStarRating initial={2} onChange={onChange} disabled />);
    fireEvent.click(starInput(4));
    expect(onChange).not.toHaveBeenCalled();
    for (const n of [1, 2, 3, 4, 5]) {
      expect(starInput(n).disabled).toBe(true);
    }
  });

  /**
   * SPEC-0001 S4: "Home/End jump to the ends" — the one part of the keyboard contract native
   * grouped radios do NOT implement on their own (see `star-rating.tsx`'s header), so this is
   * this component's own `onKeyDown` logic under test, not a browser default action.
   */
  it('Home commits and focuses the first star from anywhere in the group', () => {
    const onChange = vi.fn();
    render(<ControlledStarRating initial={3} onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: 'Your rating' });
    starInput(3).focus();
    fireEvent.keyDown(group, { key: 'Home' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(1);
    expect(document.activeElement).toBe(starInput(1));
  });

  it('End commits and focuses the last star from anywhere in the group', () => {
    const onChange = vi.fn();
    render(<ControlledStarRating initial={2} onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: 'Your rating' });
    starInput(2).focus();
    fireEvent.keyDown(group, { key: 'End' });
    expect(onChange).toHaveBeenCalledExactlyOnceWith(5);
    expect(document.activeElement).toBe(starInput(5));
  });

  it('a disabled group ignores Home/End too', () => {
    const onChange = vi.fn();
    render(<ControlledStarRating initial={2} onChange={onChange} disabled />);
    const group = screen.getByRole('radiogroup', { name: 'Your rating' });
    fireEvent.keyDown(group, { key: 'Home' });
    fireEvent.keyDown(group, { key: 'End' });
    expect(onChange).not.toHaveBeenCalled();
  });

  /**
   * THE KEYBOARD-NAVIGATION ASSERTION (ADR-0010): arrow-key movement between stars is native
   * `<input type="radio">` behaviour this component deliberately does not reimplement — a real
   * browser moves focus AND selection together on ArrowLeft/Right/Up/Down for a shared-`name`
   * radio group with no help from this file (`star-rating.tsx`'s header names this "comes
   * largely free"). happy-dom does not execute that browser default action, so the property this
   * test CAN prove at the unit level — and the one a regression would actually break — is that
   * this component's own keydown handler stays out of the way: it must not call
   * `preventDefault()` on an arrow key, which is exactly what would suppress the browser's
   * native radiogroup navigation once this renders in a real browser. Only `Home`/`End` (this
   * component's own logic, asserted above) are allowed to intercept.
   *
   * Mutated by hand per ADR-0010 to confirm this goes red: broadening `star-rating.tsx`'s Home/End
   * check to `if (event.key === 'Home' || event.key === 'End' || event.key.startsWith('Arrow'))`
   * made this test fail (`defaultPrevented` became `true`) before the line was restored.
   */
  it('does not intercept arrow keys, leaving native radiogroup navigation free to run', () => {
    render(<ControlledStarRating initial={3} />);
    const group = screen.getByRole('radiogroup', { name: 'Your rating' });
    starInput(3).focus();
    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      const event = fireEvent.keyDown(group, { key });
      // `fireEvent.*` returns `false` when the dispatched event had `preventDefault()` called —
      // i.e. `event === true` means nothing intercepted it.
      expect(event, `${key} was intercepted`).toBe(true);
    }
  });

  it('previews a hovered star without committing it, and reverts on mouse-leave', () => {
    const onChange = vi.fn();
    render(<ControlledStarRating initial={2} onChange={onChange} />);
    const group = screen.getByRole('radiogroup', { name: 'Your rating' });
    const previewedGlyph = starInput(4).closest('label')?.querySelector('svg');
    expect(previewedGlyph?.getAttribute('class')).toContain('text-content-muted');

    fireEvent.mouseEnter(starInput(4).closest('label') as Element);
    expect(previewedGlyph?.getAttribute('class')).toContain('fill-accent');
    expect(onChange).not.toHaveBeenCalled();
    expect(starInput(4).checked).toBe(false);

    fireEvent.mouseLeave(group);
    expect(previewedGlyph?.getAttribute('class')).toContain('text-content-muted');
  });

  it('previews the focused star and clears the preview on blur without committing', () => {
    const onChange = vi.fn();
    render(<ControlledStarRating initial={1} onChange={onChange} />);
    const glyph = starInput(5).closest('label')?.querySelector('svg');
    // `fireEvent.focus`/`fireEvent.blur`, not a raw `.focus()`/`.blur()` call: `fireEvent` wraps
    // dispatch in `act()`, which is what flushes the `previewValue` state update into the DOM
    // before the assertion below reads it. A bare `.focus()` fires the same React handler but
    // leaves the resulting re-render pending, which is a test-harness gap, not a component one.
    fireEvent.focus(starInput(5));
    expect(glyph?.getAttribute('class')).toContain('fill-accent');
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(starInput(5));
    expect(glyph?.getAttribute('class')).toContain('text-content-muted');
  });

  it('announces the committed value in a polite live region, and its absence honestly', () => {
    render(<ControlledStarRating initial={undefined} />);
    const liveRegion = screen.getByText('No rating selected');
    expect(liveRegion.getAttribute('aria-live')).toBe('polite');
    fireEvent.click(starInput(3));
    expect(screen.getByText('3 of 5 stars').getAttribute('aria-live')).toBe('polite');
  });
});
