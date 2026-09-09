import { describe, expect, it } from 'vitest';
import { mintToken, TOKEN_ALPHABET, TOKEN_PREFIX, TOKEN_RANDOM_LENGTH } from '../src/index.js';

// ADR-0006: the random segment is minted through `customAlphabet(TOKEN_ALPHABET, 21)`, never bare
// `nanoid()` — its default alphabet's `_`/`-` would collide with the prefix separator.
describe('TOKEN_ALPHABET', () => {
  it('is the explicit 62-symbol alphanumeric alphabet — no underscore, no hyphen', () => {
    expect(TOKEN_ALPHABET).toBe('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ');
    expect(TOKEN_ALPHABET).not.toContain('_');
    expect(TOKEN_ALPHABET).not.toContain('-');
    expect(TOKEN_ALPHABET).toHaveLength(62);
  });
});

describe('mintToken', () => {
  it('mints `{prefix}_{21-char random}` over TOKEN_ALPHABET only', () => {
    const token = mintToken(TOKEN_PREFIX.Review);
    expect(token).toMatch(/^rev_[0-9A-Za-z]{21}$/);
    const random = token.slice('rev_'.length);
    expect(random).toHaveLength(TOKEN_RANDOM_LENGTH);
    for (const char of random) {
      expect(TOKEN_ALPHABET).toContain(char);
    }
  });

  it('mints a fresh random segment on every call (collision-free at test volume)', () => {
    const tokens = new Set(Array.from({ length: 200 }, () => mintToken(TOKEN_PREFIX.Review)));
    expect(tokens.size).toBe(200);
  });
});

// The registry is the single source for every table's token prefix, so the set of prefixes is
// itself a contract: a prefix silently dropped or renamed invalidates every stored token that
// carries it, and stored tokens are in logs and support tickets. Asserting the whole set rather
// than each member means an ADDITION is also a visible, reviewed change — and it is what made
// removing the catalogue's `Product` prefix (ADR-0016: products are addressed by slug) a change a
// reviewer had to look at.
describe('TOKEN_PREFIX registry', () => {
  it('holds exactly the prefixes this system mints', () => {
    expect(TOKEN_PREFIX).toStrictEqual({ Review: 'rev', User: 'usr' });
  });

  it('gives every prefix a distinct value, so a token names one kind of thing', () => {
    const values = Object.values(TOKEN_PREFIX);
    expect(new Set(values).size).toBe(values.length);
  });

  it('keeps every prefix free of the separator it is joined with', () => {
    for (const prefix of Object.values(TOKEN_PREFIX)) {
      expect(prefix).not.toContain('_');
      expect(prefix).toMatch(/^[a-z]{3}$/);
    }
  });
});
