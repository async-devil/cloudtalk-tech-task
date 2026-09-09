import { describe, expect, it } from 'vitest';
import {
  REQUEST_MAGIC_LINK_INITIAL_STATE,
  REQUEST_MAGIC_LINK_STATUS,
  requestMagicLinkReducer,
} from '../src/features/sign-in/request-magic-link-machine.js';

/**
 * The sign-in flow's machine (ADR-0012: "interaction flows are pure `useReducer` machines" —
 * binding on EVERY feature, which is why the sign-in screen has one rather than four `useState`s).
 *
 * Driven as a pure function, with no rendering and no server: these are the rules, and a rule
 * spread across event handlers is a rule nothing can assert.
 */

function reduce(
  actions: readonly Parameters<typeof requestMagicLinkReducer>[1][],
): ReturnType<typeof requestMagicLinkReducer> {
  return actions.reduce(requestMagicLinkReducer, REQUEST_MAGIC_LINK_INITIAL_STATE);
}

describe('requestMagicLinkReducer', () => {
  it('will not submit an empty address', () => {
    expect(reduce([{ type: 'submit' }]).status).toBe(REQUEST_MAGIC_LINK_STATUS.Idle);
    expect(reduce([{ type: 'edit', email: '   ' }, { type: 'submit' }]).status).toBe(
      REQUEST_MAGIC_LINK_STATUS.Idle,
    );
  });

  it('refuses a second submit while one is in flight', () => {
    // The reason this is a machine at all: a double-click otherwise spends two sends against the
    // per-address magic-link bucket, and the second one is the user's own 429.
    const state = reduce([
      { type: 'edit', email: 'a@b.test' },
      { type: 'submit' },
      { type: 'submit' },
    ]);
    expect(state.status).toBe(REQUEST_MAGIC_LINK_STATUS.Submitting);
  });

  it('keeps the address on failure and renders REGISTERED copy', () => {
    const state = reduce([
      { type: 'edit', email: 'a@b.test' },
      { type: 'submit' },
      // The shape better-auth's client actually resolves with: a body-derived `code` plus `status`.
      { type: 'failed', error: { status: 429, code: 'RATE_LIMITED', message: 'slow down' } },
    ]);

    expect(state.status).toBe(REQUEST_MAGIC_LINK_STATUS.Error);
    expect(state.email, 'clearing the field on failure makes the user retype it').toBe('a@b.test');
    // The registered copy, not the backend's `message`: that text is operator-facing.
    expect(state.errorMessage).toBe('Too many requests. Please wait a moment and try again.');
  });

  it('falls back to a status-derived code when the body carries none', () => {
    // better-auth's OWN failures (INVALID_ORIGIN, …) are not kernel codes, so they must still land
    // on real copy rather than rendering blank.
    const state = reduce([
      { type: 'edit', email: 'a@b.test' },
      { type: 'submit' },
      { type: 'failed', error: { status: 403, code: 'INVALID_ORIGIN' } },
    ]);
    expect(state.errorMessage).toBe('You do not have access to this.');
  });

  it('clears both the error and the sent confirmation when the address is edited', () => {
    // Leaving "check your inbox" up while the user corrects a typo tells them a link is on its way
    // to an address they just abandoned.
    const afterError = reduce([
      { type: 'edit', email: 'a@b.test' },
      { type: 'submit' },
      { type: 'failed', error: { status: 500 } },
      { type: 'edit', email: 'c@d.test' },
    ]);
    expect(afterError.status).toBe(REQUEST_MAGIC_LINK_STATUS.Idle);
    expect(afterError.errorMessage).toBeUndefined();

    const afterSent = reduce([
      { type: 'edit', email: 'a@b.test' },
      { type: 'submit' },
      { type: 'sent' },
      { type: 'edit', email: 'c@d.test' },
    ]);
    expect(afterSent.status).toBe(REQUEST_MAGIC_LINK_STATUS.Idle);
  });

  it('reaches Sent and keeps the address that was used', () => {
    const state = reduce([
      { type: 'edit', email: 'a@b.test' },
      { type: 'submit' },
      { type: 'sent' },
    ]);
    expect(state.status).toBe(REQUEST_MAGIC_LINK_STATUS.Sent);
    expect(state.email).toBe('a@b.test');
    expect(state.errorMessage).toBeUndefined();
  });
});
