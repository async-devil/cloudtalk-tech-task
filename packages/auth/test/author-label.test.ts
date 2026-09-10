import { describe, expect, it } from 'vitest';
import { deriveAuthorLabel } from '../src/author-label.js';

describe('deriveAuthorLabel (SPEC-0001 open question 1)', () => {
  it('takes the local part of a well-formed email', () => {
    expect(deriveAuthorLabel('a.rivera@example.test')).toBe('a.rivera');
  });

  it('trims surrounding whitespace off the local part', () => {
    expect(deriveAuthorLabel('  spaced.out  @example.test')).toBe('spaced.out');
  });

  // Mutation: in `src/author-label.ts`, move `.trim()` to run BEFORE slicing to the local part
  // (i.e. trim the whole email first) instead of after — this specific case still passes (there
  // is no leading/trailing whitespace on the whole string), so the mutation that actually turns
  // THIS test red is dropping `.trim()` entirely: the label would then read
  // `"  spaced.out  "` instead of `"spaced.out"`.
  it('truncates a long local part to exactly 24 characters, verbatim, no ellipsis', () => {
    const longLocalPart = 'a'.repeat(40);
    const label = deriveAuthorLabel(`${longLocalPart}@example.test`);
    expect(label).toHaveLength(24);
    expect(label).toBe('a'.repeat(24));
    expect(label).not.toContain('…');
    expect(label).not.toContain('...');
  });

  it('leaves a local part shorter than 24 characters untouched', () => {
    expect(deriveAuthorLabel('short@example.test')).toBe('short');
  });

  // Mutation: in `src/author-label.ts`, change the empty-check from `localPart.length === 0` to
  // `localPart.length < 0` (never true) — the fallback branch becomes unreachable and this test's
  // `toBe('Reviewer')` goes red, receiving `''` instead.
  it("falls back to the literal 'Reviewer' when nothing is left after trimming", () => {
    expect(deriveAuthorLabel('@example.test')).toBe('Reviewer');
    expect(deriveAuthorLabel('   @example.test')).toBe('Reviewer');
  });

  it('handles an email with no "@" at all without throwing (defensive: the schema always has one)', () => {
    expect(deriveAuthorLabel('not-an-email')).toBe('not-an-email');
  });

  it('is a pure function: the same email always renders the same label', () => {
    const email = 'stable.author@example.test';
    expect(deriveAuthorLabel(email)).toBe(deriveAuthorLabel(email));
  });

  // The whole-contract assertion (SPEC-0001: "the email itself never crosses the wire in any
  // form — only this derived label does"): the label produced from a realistic email must never
  // contain the email's own domain part or the `@` separator.
  it('never returns anything containing the email domain or the "@" separator', () => {
    const label = deriveAuthorLabel('reviewer.person@some-company-domain.example');
    expect(label).not.toContain('@');
    expect(label).not.toContain('some-company-domain');
  });
});
