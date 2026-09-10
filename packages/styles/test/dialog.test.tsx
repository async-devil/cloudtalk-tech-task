import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { Button } from '../src/primitives/button.js';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../src/primitives/dialog.js';

afterEach(cleanup);

/**
 * SPEC-0001 S5's delete-confirmation shape: a trigger, a title/description, and a Cancel/Delete
 * footer built from `DialogClose` + this system's own `Button`. `Outside` sits beside the dialog
 * entirely, so a focus-trap regression that leaks focus onto the page is something a test here
 * could actually catch.
 */
function DeleteConfirmation({ showCloseButton = true }: { readonly showCloseButton?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button">Outside</button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogTrigger asChild>
          <Button>Delete review</Button>
        </DialogTrigger>
        <DialogContent showCloseButton={showCloseButton}>
          <DialogHeader>
            <DialogTitle>Delete this review?</DialogTitle>
            <DialogDescription>
              This removes your 4-star rating of Sony WH-1000XM5.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive">Delete</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

describe('Dialog', () => {
  it('is closed until the trigger opens it, then exposes a labelled dialog', async () => {
    render(<DeleteConfirmation />);
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Delete review' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete this review?' });
    expect(dialog).toBeTruthy();
  });

  it('associates DialogDescription with the dialog (Radix aria-describedby wiring)', async () => {
    render(<DeleteConfirmation />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete review' }));
    const dialog = await screen.findByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)?.textContent).toBe(
      'This removes your 4-star rating of Sony WH-1000XM5.',
    );
  });

  /**
   * FOCUS TRAP, part one (ADR-0010's mutation target — see below): Radix's `FocusScope` moves
   * focus INTO the trapped region the instant it mounts, rather than leaving it on the trigger
   * that opened it. A trap that let focus sit outside its own boundary on open would not be a
   * trap. Full Tab-key cycle containment is NOT asserted here: happy-dom does not execute the
   * browser's native Tab-key default action (verified by hand — a dispatched `keydown: 'Tab'`
   * moves nothing, the same gap `star-rating.test.tsx` documents for arrow keys), so a
   * `fireEvent.keyDown(..., { key: 'Tab' })` loop would prove nothing about Radix's own
   * boundary-correction logic. What this environment CAN exercise honestly is FocusScope's mount
   * behaviour, asserted below.
   *
   * Mutated by hand per ADR-0010 to confirm this goes red: adding
   * `onOpenAutoFocus={(event) => event.preventDefault()}` to `DialogContent`'s
   * `DialogPrimitive.Content` in `dialog.tsx` (suppressing Radix's focus-into-content behaviour,
   * exactly what a careless edit to this wrapper could do) made this test fail — focus stayed on
   * the `document.body` instead of moving into the dialog — before the line was reverted.
   */
  it('moves focus into the dialog on open, never leaving it on the trigger or the page', async () => {
    render(<DeleteConfirmation />);
    const trigger = screen.getByRole('button', { name: 'Delete review' });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(trigger);
  });

  it('Escape dismisses the dialog and returns focus to the trigger', async () => {
    render(<DeleteConfirmation />);
    const trigger = screen.getByRole('button', { name: 'Delete review' });
    fireEvent.click(trigger);
    await screen.findByRole('dialog');
    fireEvent.keyDown(document.body, { key: 'Escape', code: 'Escape' });
    expect(screen.queryByRole('dialog')).toBeNull();
    // Radix's `onCloseAutoFocus` returns focus to the trigger asynchronously (a scheduled
    // microtask, not synchronous with the dismiss), so this is `waitFor`, not an immediate
    // assertion — verified by hand: an immediate check reads `document.body`, and the same check
    // after a tick reads the trigger.
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('DialogClose (the footer Cancel button) closes the dialog and returns focus to the trigger', async () => {
    render(<DeleteConfirmation />);
    const trigger = screen.getByRole('button', { name: 'Delete review' });
    fireEvent.click(trigger);
    await screen.findByRole('dialog');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it('renders a corner close button with an accessible name by default', async () => {
    render(<DeleteConfirmation />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete review' }));
    await screen.findByRole('dialog');
    expect(screen.getByRole('button', { name: 'Close' })).toBeTruthy();
  });

  it('omits the corner close button when showCloseButton is false', async () => {
    render(<DeleteConfirmation showCloseButton={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete review' }));
    await screen.findByRole('dialog');
    expect(screen.queryByRole('button', { name: 'Close' })).toBeNull();
  });
});
