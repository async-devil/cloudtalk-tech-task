/**
 * The sign-in form's REJECTION path (review, 2026-09-09).
 *
 * better-auth's client resolves `{ data, error }` for anything the server answered, so the screen's
 * success/`failed` dispatch covers every server-side outcome. It does NOT cover a call that
 * rejects — an offline browser, a dropped connection, DNS failure — and with no `failed` dispatched
 * there, the machine stayed in `Submitting`: the form disabled, no error, no retry short of a page
 * reload. This suite drives the real component with a rejecting client and asserts the way out.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const magicLink = vi.fn();

vi.mock('../src/shared/session/auth-client.js', () => ({
  authClient: {
    signIn: {
      get magicLink() {
        return magicLink;
      },
    },
  },
  magicLinkCallbackUrl: (returnTo: string) => `https://app.example.test${returnTo}`,
}));

const { SignInScreen } = await import('../src/features/sign-in/sign-in-screen.js');

afterEach(() => {
  magicLink.mockReset();
  cleanup();
});

function submitAnAddress(): void {
  fireEvent.change(screen.getByLabelText('Email address'), {
    target: { value: 'reviewer@example.test' },
  });
  fireEvent.click(screen.getByTestId('sign-in-submit'));
}

describe('SignInScreen when the magic-link call rejects', () => {
  it('leaves Submitting: the error is shown and the form is usable again', async () => {
    magicLink.mockRejectedValue(new TypeError('Failed to fetch'));
    render(<SignInScreen returnTo="/orders" />);

    submitAnAddress();

    await waitFor(() => {
      expect(screen.getByTestId('sign-in-error')).toBeTruthy();
    });
    expect(screen.getByTestId('sign-in-submit').hasAttribute('disabled')).toBe(false);
    // The address survives the failure — retrying must not mean retyping it.
    expect((screen.getByLabelText('Email address') as HTMLInputElement).value).toBe(
      'reviewer@example.test',
    );
  });

  it('a retry after a rejection actually reaches the client again', async () => {
    magicLink.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    magicLink.mockResolvedValueOnce({ data: {}, error: null });
    render(<SignInScreen returnTo="/orders" />);

    submitAnAddress();
    await waitFor(() => {
      expect(screen.getByTestId('sign-in-error')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('sign-in-submit'));
    await waitFor(() => {
      expect(screen.getByTestId('magic-link-sent')).toBeTruthy();
    });
    expect(magicLink).toHaveBeenCalledTimes(2);
  });
});
