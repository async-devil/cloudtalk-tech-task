import { describe, expect, it } from 'vitest';
import { describeError } from '../src/index.js';

const SENTINEL = 'unknown error (no description)';

// Cases exercising every step of the describeError fallback chain. The chain is: message → name
// (skipping the information-free default 'Error') → cause (depth-capped) → string value →
// sentinel.

class WeirdError extends Error {
  override readonly name = 'WeirdError';
}

/** A default-named `Error` with an empty message (message stays `''` when the first arg is
 * `undefined`), optionally with a `cause`. Centralized so the deliberate message-less construction
 * — the exact condition describeError's name/cause/sentinel steps exist for — carries a single
 * justified suppression instead of scattering it across call sites. */
function blankError(cause?: unknown): Error {
  // biome-ignore lint/suspicious/useErrorMessage: message-less BY DESIGN — exercises the empty-message path.
  return cause === undefined ? new Error() : new Error(undefined, { cause });
}

describe('describeError — step 1: Error message', () => {
  it('non-empty message wins', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('trims the message', () => {
    expect(describeError(new Error('  spaced  '))).toBe('spaced');
  });

  it('whitespace-only message falls through', () => {
    // A default-named Error with a blank message has nothing at steps 1–3 → sentinel. The
    // whitespace message is the point — nonEmptyTrimmed must reject it.
    // biome-ignore lint/suspicious/useErrorMessage: whitespace-only message is exactly what's under test.
    expect(describeError(new Error('   '))).toBe(SENTINEL);
  });
});

describe('describeError — step 2: Error name, skipping the default (recorded deviation)', () => {
  it('a custom name is used when the message is empty', () => {
    expect(describeError(new WeirdError())).toBe('WeirdError');
  });

  it("the default name 'Error' is SKIPPED (would make cause/sentinel unreachable)", () => {
    // Empty message + default name → must NOT return 'Error'; falls to cause, then sentinel.
    expect(describeError(blankError())).toBe(SENTINEL);
  });
});

describe('describeError — step 3: cause recursion, depth-capped', () => {
  it('recurses into cause when message and name are exhausted', () => {
    expect(describeError(blankError(new Error('root cause')))).toBe('root cause');
  });

  it('recurses two levels deep', () => {
    expect(describeError(blankError(blankError(new Error('bottom'))))).toBe('bottom');
  });

  it('a self-caused error terminates (depth cap) and returns the sentinel — does not hang', () => {
    const cyclic = blankError();
    (cyclic as { cause?: unknown }).cause = cyclic;
    expect(describeError(cyclic)).toBe(SENTINEL);
  });
});

describe('describeError — step 4: string throwable', () => {
  it('a non-empty string is its own description', () => {
    expect(describeError('plain failure')).toBe('plain failure');
  });

  it('an empty string falls through to the sentinel', () => {
    expect(describeError('')).toBe(SENTINEL);
  });
});

describe('describeError — step 5: sentinel for non-describable values', () => {
  it.each([
    { label: 'null', value: null },
    { label: 'undefined', value: undefined },
    { label: 'number', value: 42 },
    { label: 'empty object', value: {} },
  ])('$label → sentinel', ({ value }) => {
    expect(describeError(value)).toBe(SENTINEL);
  });
});

describe('describeError — totality (never empty)', () => {
  it.each([
    new Error('boom'),
    blankError(),
    new WeirdError(),
    blankError(new Error('c')),
    'a string',
    '',
    null,
    undefined,
    42,
    {},
  ])('describeError(%o) returns a non-empty string', (value) => {
    expect(describeError(value).length).toBeGreaterThan(0);
  });
});
