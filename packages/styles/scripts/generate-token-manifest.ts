/**
 * Generates `src/tokens/manifest.ts` from `src/tokens/*.css`.
 *
 * WHAT THE MANIFEST IS FOR. It is what ARMS the adherence gate. Rule 5 — "no `var(--foo)` naming a
 * token this system does not declare" — is the rule that makes "retokenised" a checkable property
 * rather than a claim, and it can only exist if something machine-readable knows the full token
 * set. A hand-maintained list would drift from the CSS the first time anyone was in a hurry, so
 * this is generated and its freshness is asserted by regenerate-and-diff, the same mechanism the
 * route tree and the kysely types already use.
 *
 * GENERATION PLUS DIFF *IS* THE BOTH-DIRECTIONS RECONCILIATION ADR-0012 ASKS FOR: a token in
 * the CSS with no manifest entry and a manifest entry naming no real token each show up as a dirty
 * diff, because the generator's output is a pure function of the CSS.
 *
 * Reads the `:root` blocks, NOT the `@theme inline` blocks — `:root` is where values live
 * (see `tokens/colors.css`'s header), and `@theme` merely re-registers the same names, so parsing
 * both would double-count every token.
 *
 * Lives in `scripts/`, not `src/`: it reads the filesystem and is a build tool, not part of the
 * browser bundle — the same placement and the same reason as `apps/app/scripts/check-route-tree.ts`.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(SCRIPT_DIR, '..');
const TOKENS_DIR = path.join(PACKAGE_ROOT, 'src', 'tokens');
const MANIFEST_PATH = path.join(TOKENS_DIR, 'manifest.ts');

/**
 * Token kind, derived from the name's prefix. The set is closed on purpose (ADR-0003): a token
 * whose prefix matches nothing here is a NAMING mistake — this system has no "miscellaneous"
 * category — and the generator refuses rather than inventing one.
 */
const KIND_BY_PREFIX = [
  { prefix: '--color-', kind: 'color' },
  { prefix: '--text-', kind: 'text' },
  { prefix: '--radius-', kind: 'radius' },
  { prefix: '--shadow-', kind: 'shadow' },
  { prefix: '--duration-', kind: 'motion' },
  { prefix: '--ease-', kind: 'motion' },
  { prefix: '--size-', kind: 'size' },
  // safe-area quartet. A kind of its own rather than folded into `size`: these are
  // INSETS supplied by the platform (`env(safe-area-inset-*)`), not values this system chose, and
  // the distinction is what a reader needs to know before trying to re-brand one.
  { prefix: '--spacing-', kind: 'spacing' },
] as const;

export type TokenKind = (typeof KIND_BY_PREFIX)[number]['kind'];

function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The `:root { … }` block's body. Returns '' when the file has none — `base.css` legitimately
 * declares no tokens, and treating that as an error would force a fake block into it. */
function rootBlockBody(css: string): string {
  const start = css.indexOf(':root');
  if (start < 0) {
    return '';
  }
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  return open < 0 || close < 0 ? '' : css.slice(open + 1, close);
}

export interface TokenEntry {
  readonly name: string;
  readonly kind: TokenKind;
}

function kindOf(name: string): TokenKind | undefined {
  return KIND_BY_PREFIX.find(({ prefix }) => name.startsWith(prefix))?.kind;
}

/** Every token declared across the token folder, sorted, deduped, each with its kind. */
export function collectTokens(tokensDir: string): readonly TokenEntry[] {
  const byName = new Map<string, TokenKind>();
  const unknown: string[] = [];

  const files = readdirSync(tokensDir)
    .filter((file) => file.endsWith('.css'))
    .sort();
  for (const file of files) {
    const body = rootBlockBody(withoutComments(readFileSync(path.join(tokensDir, file), 'utf8')));
    const pattern = /(--[a-z0-9-]+)\s*:/g;
    let match = pattern.exec(body);
    while (match !== null) {
      const name = match[1];
      if (name !== undefined) {
        const kind = kindOf(name);
        if (kind === undefined) {
          unknown.push(`${name} (${file})`);
        } else {
          byName.set(name, kind);
        }
      }
      match = pattern.exec(body);
    }
  }

  if (unknown.length > 0) {
    throw new Error(
      `token manifest: ${unknown.length} token(s) match no known kind prefix: ${unknown.join(', ')}. ` +
        'Either the name is wrong, or KIND_BY_PREFIX needs a new entry — decide deliberately ' +
        'rather than letting the manifest grow a category nobody chose.',
    );
  }
  return [...byName]
    .map(([name, kind]) => ({ name, kind }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
}

export function renderManifest(tokens: readonly TokenEntry[]): string {
  const rows = tokens.map(({ name, kind }) => `  '${name}': '${kind}',`).join('\n');
  return `/**
 * GENERATED FILE — DO NOT EDIT.
 *
 * Regenerate with \`moon run styles:token-manifest\`; \`styles:token-manifest-check\` re-runs the
 * generator in CI and diffs, so an edit here is reverted by the next generation and fails the gate
 * in the meantime.
 *
 * Source: \`src/tokens/*.css\` (the \`:root\` blocks, where values live).
 * Generator: \`scripts/generate-token-manifest.ts\`.
 *
 * This is what ARMS the design-system adherence gate: the "undeclared token
 * reference" rule — no \`var(--foo)\` naming a token this system does not declare — is what makes
 * "retokenised" checkable instead of claimed, and it needs a machine-readable token set to exist
 * at all.
 */

/** Every design token this system declares, with its kind. */
export const TOKEN_MANIFEST = {
${rows}
} as const;

export type TokenName = keyof typeof TOKEN_MANIFEST;
export type TokenKind = (typeof TOKEN_MANIFEST)[TokenName];

/** The token names as a list — the form the gate's lookups want. */
export const TOKEN_NAMES: readonly TokenName[] = Object.keys(TOKEN_MANIFEST) as TokenName[];
`;
}

function main(): number {
  const tokens = collectTokens(TOKENS_DIR);
  if (tokens.length === 0) {
    console.error(
      'token manifest: the token folder declares NOTHING. Refusing to write an empty manifest — ' +
        'an empty manifest disarms every rule that reads it (rule 0).',
    );
    return 1;
  }
  writeFileSync(MANIFEST_PATH, renderManifest(tokens), 'utf8');
  console.log(`token manifest: wrote ${tokens.length} tokens to src/tokens/manifest.ts`);
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
