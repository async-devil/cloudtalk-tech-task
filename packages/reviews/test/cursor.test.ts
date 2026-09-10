import { ValidationError } from '@repo/kernel';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../src/internal/cursor.js';

const payloadSchema = z.object({ v: z.literal(1), productSlug: z.string(), token: z.string() });

describe('encodeCursor / decodeCursor', () => {
  it('round-trips a payload through decodeCursor unchanged', () => {
    const payload = {
      v: 1 as const,
      productSlug: 'sony-wh-1000xm5',
      token: 'rev_ABCDEFGHIJKLMNOPQRSTU',
    };
    const cursor = encodeCursor(payload);
    expect(decodeCursor(cursor, payloadSchema)).toEqual(payload);
  });

  // Mutation: in `src/internal/cursor.ts`, replace `'base64url'` with `'utf8'` in either
  // `Buffer.from`/`.toString` call — the round-trip above would still pass (both sides would
  // agree on the wrong encoding), but this test's OWN opaque-string assertion goes red: a
  // `base64url` string never contains `+`, `/` or `=`, which a `utf8`-then-relabelled string
  // could easily contain by accident of the JSON payload's own characters.
  it('produces a base64url string, never containing +, / or =', () => {
    const cursor = encodeCursor({ v: 1, productSlug: 'a-product', token: 'rev_x' });
    expect(cursor).not.toMatch(/[+/=]/);
  });

  it('is opaque: the cursor is not the payload rendered as plain text', () => {
    const cursor = encodeCursor({ v: 1, productSlug: 'a-very-findable-slug', token: 'rev_x' });
    expect(cursor).not.toContain('a-very-findable-slug');
  });

  // Mutation: in `decodeCursor`, drop the `try`/`catch` around `Buffer.from(cursor, 'base64url')`
  // — an invalid string still decodes to SOME byte sequence under base64url (it is a permissive
  // alphabet), so this particular input does not itself throw at that step; the assertion below
  // is instead what the JSON.parse guard exists for, and removing THAT catch is what turns this
  // test red (a `SyntaxError` propagates instead of the typed `ValidationError`).
  it('throws ValidationError({ field: "cursor" }) for a cursor that is not valid base64url JSON', () => {
    let caught: unknown;
    try {
      decodeCursor('not-valid-base64url-json!!!', payloadSchema);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).details).toEqual({ field: 'cursor' });
  });

  // Mutation: in `decodeCursor`, replace `schema.safeParse(parsed)` with an unconditional
  // `schema.parse(parsed)` cast (skip the `!result.success` check) — a payload missing a required
  // field would then throw zod's own `ZodError` instead of the typed `ValidationError`, and this
  // test's `toBeInstanceOf(ValidationError)` goes red.
  it('throws ValidationError({ field: "cursor" }) for well-formed JSON that fails the schema', () => {
    const cursor = encodeCursor({ v: 1, productSlug: 'a-product' }); // missing `token`
    let caught: unknown;
    try {
      decodeCursor(cursor, payloadSchema);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).details).toEqual({ field: 'cursor' });
  });

  it('throws ValidationError for a cursor minted for a completely different schema shape', () => {
    const cursor = encodeCursor({ totallyDifferent: true });
    expect(() => decodeCursor(cursor, payloadSchema)).toThrow(ValidationError);
  });
});
