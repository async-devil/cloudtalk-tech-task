/**
 * The product form's human-price <-> `priceMinor` conversion (TASK-0008, SPEC-0001 screen S7).
 *
 * A ONE-OFF, kept in this slice rather than promoted to `shared/`: nothing else in this app needs
 * the INVERSE of `shared/formatting/money.ts`'s `formatPriceMinor` (display-only, minor units ->
 * text) — this form is the one place minor units are ever produced from user-typed text.
 *
 * Same `Intl.NumberFormat` `maximumFractionDigits` technique `formatPriceMinor` already uses to
 * read a currency's minor-unit exponent (never assuming two digits — JPY has none, some currencies
 * have three), but defensive where that function is not: `formatPriceMinor`'s callers only ever
 * hand it a WIRE-VALIDATED `currencyCode` (`^[A-Z]{3}$`, already persisted), while this form's
 * currency field is live, unvalidated text a user is still typing — `Intl.NumberFormat` throws a
 * `RangeError` SYNCHRONOUSLY for a currency code it does not recognise, so every read here is
 * wrapped in a `try/catch` that the display-only formatter does not need.
 */

/** ISO 4217's own fallback, same value `money.ts` uses for the same reason — only reached when a
 * currency code cannot be resolved at all (unrecognised, or genuinely mid-edit). */
const DEFAULT_MINOR_UNIT_DIGITS = 2;

function minorUnitDigitsFor(currencyCode: string): number {
  try {
    const formatter = new Intl.NumberFormat(undefined, {
      style: 'currency',
      currency: currencyCode,
    });
    return formatter.resolvedOptions().maximumFractionDigits ?? DEFAULT_MINOR_UNIT_DIGITS;
  } catch {
    return DEFAULT_MINOR_UNIT_DIGITS;
  }
}

/**
 * Parses a human-typed price (e.g. `"349.99"`) into `priceMinor` for `productsCreateInputSchema`/
 * `productsUpdateInputSchema` (both `z.number().int().nonnegative()`). `undefined` for anything
 * that is not a non-negative finite number once parsed — the caller treats that as a validation
 * failure, never as a silent `0`.
 */
export function priceMajorToMinor(priceMajor: string, currencyCode: string): number | undefined {
  const trimmed = priceMajor.trim();
  if (trimmed === '') {
    return undefined;
  }
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return undefined;
  }
  return Math.round(parsed * 10 ** minorUnitDigitsFor(currencyCode));
}

/** The inverse, for prefilling the edit form from a `ProductDetail.priceMinor`. */
export function minorToPriceMajorInput(priceMinor: number, currencyCode: string): string {
  const digits = minorUnitDigitsFor(currencyCode);
  return (priceMinor / 10 ** digits).toFixed(digits);
}
