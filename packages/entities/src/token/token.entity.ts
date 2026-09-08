import { customAlphabet } from 'nanoid';

/**
 * Public-token prefix registry (ADR-0006) — the single source for every table's `token` column
 * prefix. A new content table that gains a public token adds one entry here, never a per-table
 * literal in a migration's `CHECK` comment or an app-side default.
 */
export const TOKEN_PREFIX = {
  /** `reviews.product.token` — the catalogue product's public identifier; `product_id` never
   * crosses an API boundary. */
  Product: 'prd',
  /** `reviews.review.token` — a submitted review's public identifier; `review_id` never crosses
   * an API boundary. */
  Review: 'rev',
  /** `auth.app_user.token` — the app-owned user record's public identifier (option B): domain
   * tables reference `app_user_id` and the token is the only user identifier that crosses the
   * wire; the better-auth identity id never leaves the auth schema. */
  User: 'usr',
} as const;
export type TokenPrefix = (typeof TOKEN_PREFIX)[keyof typeof TOKEN_PREFIX];

/**
 * The explicit 62-symbol alphanumeric alphabet (ADR-0006) — deliberately NOT nanoid's default
 * (`A-Za-z0-9_-`), whose `_`/`-` collide with the token's own prefix separator and break in URLs
 * and CSV exports. `customAlphabet(TOKEN_ALPHABET, TOKEN_RANDOM_LENGTH)` is the only sanctioned
 * way to mint the random segment — bare `nanoid()` must never be reached for a token.
 */
export const TOKEN_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** Random-segment length (ADR-0006: ~125 bits at this alphabet size — collision-free at any
 * volume this system will see). Pinned by every table's `token` `CHECK`
 * (e.g. `^prd_[0-9A-Za-z]{21}$`). */
export const TOKEN_RANDOM_LENGTH = 21;

const randomSegment = customAlphabet(TOKEN_ALPHABET, TOKEN_RANDOM_LENGTH);

/**
 * Mints a public token: `{prefix}_{21-char random}` over {@link TOKEN_ALPHABET} (ADR-0006) — the
 * ONLY sanctioned way to produce a `token` column value anywhere in this repository. Never call
 * `nanoid()` bare: its default alphabet's `_`/`-` would silently break the prefix-separator
 * convention every log grep and `CHECK` constraint relies on.
 */
export function mintToken(prefix: TokenPrefix): string {
  return `${prefix}_${randomSegment()}`;
}
