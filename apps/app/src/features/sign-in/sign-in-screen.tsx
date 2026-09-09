import { Button, Card, CardContent, FieldError, Input, Label, Spinner } from '@repo/styles';
import { useId, useReducer } from 'react';
import { authClient, magicLinkCallbackUrl } from '../../shared/session/auth-client.js';
import {
  REQUEST_MAGIC_LINK_INITIAL_STATE,
  REQUEST_MAGIC_LINK_STATUS,
  requestMagicLinkReducer,
} from './request-magic-link-machine.js';

/**
 * The public sign-in surface (the router's `PUBLIC_ROUTES`, the better-auth client wired in
 * `shared/session`).
 *
 * This is the app's FRONT DOOR: without it the only way to obtain a session is the test-only
 * session-mock route, which exists in `APP_MODE=test` alone.
 */
export interface SignInScreenProps {
  /** The in-app path the session guard bounced the user from, already validated as a same-origin
   * path by the route (`routes/sign-in.tsx`). Carried through sign-in so the magic link returns
   * them where they were going. */
  readonly returnTo: string;
}

export function SignInScreen({ returnTo }: SignInScreenProps) {
  const emailFieldId = useId();
  const errorId = useId();
  const [state, dispatch] = useReducer(requestMagicLinkReducer, REQUEST_MAGIC_LINK_INITIAL_STATE);

  const isSubmitting = state.status === REQUEST_MAGIC_LINK_STATUS.Submitting;

  async function requestLink(): Promise<void> {
    // better-auth's client RESOLVES `{ data, error }` rather than rejecting for a server-answered
    // failure, so the `error` branch below is the one a 429 takes — a handler that only awaited and
    // assumed success would treat a 429 as a sent link and tell the user to check an inbox nothing
    // was sent to.
    //
    // It can still REJECT, though, and that is what the catch is for (review, 2026-09-09): a
    // dropped connection, DNS failure or an offline browser never reaches the resolve path. With
    // no `failed` dispatched, the machine stayed in `Submitting` forever — the form disabled, no
    // error shown, and no way back short of reloading the page. Every exit from this call now ends
    // in a dispatch, so `Submitting` is always left.
    try {
      const { error } = await authClient.signIn.magicLink({
        email: state.email.trim(),
        callbackURL: magicLinkCallbackUrl(returnTo),
      });
      dispatch(
        error === null || error === undefined ? { type: 'sent' } : { type: 'failed', error },
      );
    } catch (error) {
      dispatch({ type: 'failed', error });
    }
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 p-4">
      <Card>
        <CardContent className="flex flex-col gap-3">
          <h1 className="text-display">Sign in</h1>

          {state.status === REQUEST_MAGIC_LINK_STATUS.Sent ? (
            <p data-testid="magic-link-sent">Check your inbox for a sign-in link.</p>
          ) : null}

          <form
            className="flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (state.email.trim() === '' || isSubmitting) {
                return;
              }
              dispatch({ type: 'submit' });
              void requestLink();
            }}
          >
            {/* `useId`, not a literal: the label/control pairing is what makes this form usable by
                assistive tech, and a hardcoded id silently breaks it if the screen renders twice. */}
            <Label htmlFor={emailFieldId}>Email address</Label>
            <Input
              id={emailFieldId}
              name="email"
              type="email"
              autoComplete="email"
              required
              value={state.email}
              disabled={isSubmitting}
              aria-invalid={state.errorMessage !== undefined}
              aria-describedby={state.errorMessage === undefined ? undefined : errorId}
              onChange={(event) => {
                dispatch({ type: 'edit', email: event.target.value });
              }}
            />
            {state.errorMessage !== undefined && (
              <FieldError id={errorId} data-testid="sign-in-error">
                {state.errorMessage}
              </FieldError>
            )}
            {/* Carried through the form so the post-sign-in landing is the page the user asked
                for — and readable by the e2e that proves the guard preserved it. */}
            <input type="hidden" name="returnTo" value={returnTo} data-testid="return-to" />
            <Button type="submit" disabled={isSubmitting} data-testid="sign-in-submit">
              {isSubmitting ? (
                <>
                  <Spinner size="inline" label="Sending…" />
                  Sending…
                </>
              ) : (
                'Email me a sign-in link'
              )}
            </Button>
          </form>
        </CardContent>
      </Card>
    </main>
  );
}
