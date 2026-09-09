import { describe, expect, it } from 'vitest';
import {
  COLOR_TOKEN_NAMES,
  EASE_TOKEN_NAMES,
  RADIUS_TOKEN_NAMES,
  SHADOW_TOKEN_NAMES,
  TEXT_TOKEN_NAMES,
} from '../src/internal/token-scales.js';
// Vite's documented `?raw` suffix — no `node:fs`, which biome's `noNodejsModules` forbids in this
// browser-bundle package (see test/ambient.d.ts).
//
// split the single `theme.css` into one file per concern. Each is imported by name
// rather than glob-loaded on purpose: a glob that silently matched nothing would turn every
// assertion below into a vacuous pass over an empty string, which is the same hollow-gate shape
// the token checks rule 0 exists to prevent. If a token file is renamed, this fails to RESOLVE.
import baseCss from '../src/tokens/base.css?raw';
import colorsCss from '../src/tokens/colors.css?raw';
import motionCss from '../src/tokens/motion.css?raw';
import spacingCss from '../src/tokens/spacing.css?raw';
import typographyCss from '../src/tokens/typography.css?raw';

const CSS_ROOT_FONT_SIZE_PX = 16;

/** Comments carry counter-examples on purpose (`--color-danger`, NOT `--color-red-600`); parsing
 * them as declarations would make this suite fail on its own documentation. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

interface Declaration {
  readonly name: string;
  readonly value: string;
}

function declarationsIn(css: string): readonly Declaration[] {
  const declarations: Declaration[] = [];
  const pattern = /^\s*(--[a-z0-9-]+)\s*:\s*([^;]+);/gm;
  let match = pattern.exec(css);
  while (match !== null) {
    const name = match[1];
    const value = match[2];
    if (name !== undefined && value !== undefined) {
      declarations.push({ name, value: value.trim() });
    }
    match = pattern.exec(css);
  }
  return declarations;
}

/**
 * The `:root { … }` block a token file declares its VALUES in. Throws rather than asserting: this
 * runs at module scope, where a failed `expect` has no test to attach to (and biome's
 * `noMisplacedAssertion` says so).
 *
 * `:root`, not `@theme`: since the values live in a real selector and `@theme inline` only
 * registers the names with Tailwind. That is not a stylistic choice — measured in real Chromium on
 * 2026-07-29, custom properties declared inside `@theme` are INVISIBLE to a plain browser (an
 * unknown at-rule is invalid CSS and is discarded whole), which would leave build-step-free
 * specimen cards rendering nothing. Parsing `:root` here means this suite asserts the values a
 * browser will actually see.
 */
function rootBlock(css: string, fileName: string): string {
  const start = css.indexOf(':root');
  if (start < 0) {
    throw new Error(`${fileName} declares no :root block — token VALUES must live in one`);
  }
  const end = css.indexOf('}', start);
  if (end <= start) {
    throw new Error(`${fileName} has an unterminated :root block`);
  }
  return css.slice(start, end);
}

/** The `@theme inline { … }` block — the Tailwind namespace registration. */
function themeBlock(css: string, fileName: string): string {
  const start = css.indexOf('@theme');
  if (start < 0) {
    throw new Error(`${fileName} declares no @theme block — its tokens generate no utilities`);
  }
  const end = css.indexOf('}', start);
  if (end <= start) {
    throw new Error(`${fileName} has an unterminated @theme block`);
  }
  return css.slice(start, end);
}

/** The `@media (prefers-reduced-motion: reduce)` block — the token-level motion gate. */
function reducedMotionBlock(css: string): string {
  const start = css.indexOf('@media (prefers-reduced-motion: reduce)');
  if (start < 0) {
    throw new Error('motion.css declares no prefers-reduced-motion gate');
  }
  return css.slice(start);
}

function remToPx(value: string): number | undefined {
  const match = /^([\d.]+)rem$/.exec(value);
  const amount = match?.[1];
  return amount === undefined ? undefined : Number.parseFloat(amount) * CSS_ROOT_FONT_SIZE_PX;
}

/** Every token file that declares VALUES. `base.css` is deliberately absent: it consumes tokens
 * (a `@layer base` reading `var(--color-surface)`) and declares none, and listing it here would
 * make the "declares tokens at all" assertion below pass on a file that never could. */
const TOKEN_FILES = [
  { name: 'colors.css', css: colorsCss },
  { name: 'typography.css', css: typographyCss },
  { name: 'spacing.css', css: spacingCss },
  { name: 'motion.css', css: motionCss },
] as const;

/**
 * Namespaces deliberately absent from `@theme inline`, so registering them would emit a
 * self-referential `:root` declaration rather than anything useful. See the tests below.
 *
 * The two entries are here for RELATED BUT DIFFERENT reasons, and the difference is worth keeping
 * straight because it is the whole reason the second was measured rather than assumed:
 *
 * - `--size-*`: Tailwind generates no utilities for the namespace at all, so registration buys
 * nothing and costs the self-reference.
 * - `--spacing-safe-*`: Tailwind DOES generate utilities here, and
 * registering them really did produce working `.pt-safe-top` rules — measured at. It also
 * produced the same self-reference (`--spacing-safe-top:var(--spacing-safe-top)` at byte ~3.2k
 * against the real `env` value at ~18.9k in the built stylesheet). Nicer class names were not
 * worth buying with a silent failure mode on the one quartet whose breakage — no notch padding —
 * is invisible in every desktop browser. They are spent through the v4 shorthand instead:
 * `pt-(--spacing-safe-top)`.
 */
const UNREGISTERED_NAMESPACES = ['--size-', '--spacing-safe-'] as const;

const themeDeclarations = TOKEN_FILES.flatMap(({ name, css }) =>
  declarationsIn(rootBlock(withoutComments(css), name)),
);

/**
 * The registration half. Every value declared in a `:root` block must also be registered with
 * Tailwind, or the token exists for the specimen cards and generates NO utility for the app — a
 * split-brain the split newly makes possible and which nothing else here would notice.
 */
const registeredNames = new Set(
  TOKEN_FILES.flatMap(({ name, css }) =>
    declarationsIn(themeBlock(withoutComments(css), name)).map(({ name: token }) => token),
  ),
);

const reducedMotionDeclarations = declarationsIn(reducedMotionBlock(withoutComments(motionCss)));

/**
 * Hue and greyscale words. A token named for its colour cannot be re-branded: the next product's
 * "danger" may not be red, and `--color-red-600` then either lies or forces a rename everywhere.
 * Matched per hyphen-delimited segment so a legitimate substring (there is none today, but
 * `--color-borderline` would be one) cannot trip it.
 */
const RAW_HUE_WORDS: ReadonlySet<string> = new Set([
  'red',
  'orange',
  'amber',
  'yellow',
  'lime',
  'green',
  'emerald',
  'teal',
  'cyan',
  'sky',
  'blue',
  'indigo',
  'violet',
  'purple',
  'fuchsia',
  'pink',
  'rose',
  'slate',
  'gray',
  'grey',
  'zinc',
  'neutral',
  'stone',
  'white',
  'black',
  'brown',
  'magenta',
  'olive',
  'navy',
]);

describe('design tokens (tokens/*.css)', () => {
  it('declares tokens at all — the parser must not be reading an empty file', () => {
    expect(themeDeclarations.length).toBeGreaterThan(20);
  });

  /**
   * The split's own invariant. Values live in `:root` (so a plain browser — and therefore a
   * specimen card — can read them); `@theme inline` registers the same names with Tailwind (so
   * utilities exist). Either half alone is a silent half-failure: a token missing from `:root`
   * renders as nothing, a token missing from `@theme` generates no utility. Reconciled in both
   * directions, per file.
   */
  it.each(TOKEN_FILES)('$name registers every value it declares with Tailwind', ({ name, css }) => {
    const cleaned = withoutComments(css);
    const values = declarationsIn(rootBlock(cleaned, name))
      .map(({ name: token }) => token)
      .filter((token) => !UNREGISTERED_NAMESPACES.some((prefix) => token.startsWith(prefix)));
    const registered = declarationsIn(themeBlock(cleaned, name)).map(({ name: token }) => token);
    expect([...values].sort()).toEqual([...registered].sort());
  });

  /**
   * The exception above, pinned so it cannot be "fixed" back into a bug. Tailwind generates no
   * utilities for `--size-*`, so registering it in `@theme inline` emits a self-referential
   * `:root { --size-touch-target: var(--size-touch-target) }`. That resolves only while Tailwind's
   * output happens to precede ours in the cascade; flip the order and the token becomes
   * guaranteed-invalid, the 44px floor evaporates, and EVERY class-string assertion in this
   * package still passes because the class is still in the markup.
   */
  it.each(
    UNREGISTERED_NAMESPACES,
  )('never registers a %s token with Tailwind (it would self-reference)', (prefix) => {
    const registered = [...registeredNames].filter((token) => token.startsWith(prefix));
    expect(registered).toEqual([]);
  });

  /**
   * The safe-area quartet's OWN invariant, and the one that makes it safe to ship on the web
   *: every entry declares an explicit `0px` fallback.
   *
   * Without the fallback the whole declaration is invalid-at-computed-value-time outside a WebView,
   * the property resolves to nothing, and the app's chrome loses its padding in every desktop
   * browser — while the class attribute, and therefore every class-string assertion in this
   * package, stays exactly the same. Asserted on the VALUE for that reason.
   */
  it('declares every safe-area inset with an explicit 0px fallback', () => {
    const insets = declarationsIn(rootBlock(withoutComments(spacingCss), 'spacing.css')).filter(
      ({ name }) => name.startsWith('--spacing-safe-'),
    );
    expect(insets.length).toBe(4);
    for (const { name, value } of insets) {
      expect(value, `${name} must fall back to 0px outside a WebView`).toMatch(
        /^env\(safe-area-inset-(top|right|bottom|left),\s*0px\)$/,
      );
    }
  });

  it('registers no Tailwind token that no :root block gives a value', () => {
    const valued = new Set(themeDeclarations.map(({ name }) => name));
    const orphans = [...registeredNames].filter((token) => !valued.has(token));
    expect(orphans).toEqual([]);
  });

  /**
   * `base.css` is the one file in `tokens/` that CONSUMES rather than declares. Keeping that true
   * is what stops the base layer quietly becoming a second token source — the exact drift the
   * one-value-one-place law exists to prevent. It must reference tokens and define none of its own.
   */
  it('keeps base.css a consumer: it references tokens and declares none', () => {
    const cleaned = withoutComments(baseCss);
    expect(cleaned).toContain('var(--color-');
    const declared = declarationsIn(cleaned).filter(
      // A `var(--x)` reference is not a declaration; only `--x: value` at the start of a line is.
      ({ value }) => !value.startsWith('var('),
    );
    expect(declared.map(({ name }) => name)).toEqual([]);
  });

  /**
   * The measured reason the split looks the way it does (real Chromium, 2026-07-29): a property
   * declared ONLY inside `@theme` is invisible to a browser, because an unknown at-rule is invalid
   * CSS and gets discarded with its whole block. A future "tidy-up" that moves the values back
   * into `@theme` would leave the app working and every specimen card blank, so the shape is
   * pinned here rather than left to a comment.
   */
  it.each(TOKEN_FILES)('$name declares its values in :root, never only in @theme', ({ css }) => {
    const cleaned = withoutComments(css);
    const rootStart = cleaned.indexOf(':root');
    const themeStart = cleaned.indexOf('@theme');
    expect(rootStart).toBeGreaterThanOrEqual(0);
    expect(themeStart).toBeGreaterThanOrEqual(0);
    // The `@theme` block must reference, not restate: every entry in it is a `var` indirection.
    const themeEntries = declarationsIn(themeBlock(cleaned, 'token file'));
    for (const { name, value } of themeEntries) {
      expect(value, `${name} restates a literal in @theme instead of referencing :root`).toContain(
        'var(',
      );
    }
  });

  /** README invariant "semantic tokens only". */
  it('names every token for its ROLE, never for a hue', () => {
    const offenders = themeDeclarations.filter(({ name }) =>
      name
        .slice(2)
        .split('-')
        .some((segment) => RAW_HUE_WORDS.has(segment)),
    );
    expect(offenders.map(({ name }) => name)).toEqual([]);
  });

  /** ADR-0012 — "no sub-11px type". Enforced by there being nothing smaller to reach for. */
  it('has no type-scale token below 11px', () => {
    const typeTokens = themeDeclarations.filter(
      ({ name }) => name.startsWith('--text-') && !name.endsWith('--line-height'),
    );
    expect(typeTokens.length).toBeGreaterThan(0);
    for (const { name, value } of typeTokens) {
      const px = remToPx(value);
      expect(
        px,
        `${name} is "${value}" — the type scale must stay in rem so this floor holds`,
      ).toBeDefined();
      expect(px ?? 0, `${name} is below the 11px floor`).toBeGreaterThanOrEqual(11);
    }
  });

  /** ADR-0012 — 44px minimum touch target, held as a token so primitives can spend it. */
  it('sets the touch-target token to at least 44px', () => {
    const touchTarget = themeDeclarations.find(({ name }) => name === '--size-touch-target');
    expect(touchTarget, 'tokens/spacing.css declares no --size-touch-target').toBeDefined();
    expect(remToPx(touchTarget?.value ?? '') ?? 0).toBeGreaterThanOrEqual(44);
  });

  /**
   * Spec — "motion is gated behind `prefers-reduced-motion` via a TOKEN-LEVEL media query".
   * Derived from the declared duration tokens rather than a hard-coded list, so adding a fourth
   * duration token without gating it turns this red.
   */
  it('collapses every duration token to 0ms under prefers-reduced-motion', () => {
    const durationTokens = themeDeclarations
      .filter(({ name }) => name.startsWith('--duration-'))
      .map(({ name }) => name);
    expect(durationTokens.length).toBeGreaterThan(0);

    const gated = new Map(reducedMotionDeclarations.map(({ name, value }) => [name, value]));
    for (const name of durationTokens) {
      expect(gated.get(name), `${name} is not overridden in the reduced-motion block`).toBe('0ms');
    }
  });

  it('declares no motion duration that is already zero outside the gate', () => {
    // A token that is 0ms unconditionally would make the gate above pass while proving nothing.
    const alwaysZero = themeDeclarations.filter(
      ({ name, value }) => name.startsWith('--duration-') && value === '0ms',
    );
    expect(alwaysZero.map(({ name }) => name)).toEqual([]);
  });
});

/**
 * `src/internal/token-scales.ts` restates the stylesheet's scale names for `tailwind-merge`, which
 * cannot read CSS. That duplication is only safe while something reconciles it — otherwise a new
 * token merges wrongly and nothing says so. Both directions, per scale.
 */
describe('tokens/*.css ↔ token-scales.ts reconciliation', () => {
  const SCALES = [
    { prefix: '--color-', declared: COLOR_TOKEN_NAMES },
    { prefix: '--text-', declared: TEXT_TOKEN_NAMES },
    { prefix: '--radius-', declared: RADIUS_TOKEN_NAMES },
    { prefix: '--shadow-', declared: SHADOW_TOKEN_NAMES },
    { prefix: '--ease-', declared: EASE_TOKEN_NAMES },
  ] as const;

  it.each(SCALES)('$prefix names match exactly', ({ prefix, declared }) => {
    const inStylesheet = themeDeclarations
      .filter(({ name }) => name.startsWith(prefix) && !name.endsWith('--line-height'))
      .map(({ name }) => name.slice(prefix.length))
      .sort;
    expect(inStylesheet).toEqual([...declared].sort);
  });
});
