/**
 * `shared/formatting`'s second pure formatter, for the same "two slices need it" reason
 * `relative-time.ts` documents: `catalogue`'s card and `product-detail`'s header both render a
 * product's price (SPEC-0001 S2/S3), and neither slice may import the other.
 *
 * `Intl.NumberFormat`, no new dependency (TASK-0004's own instruction) — but a plain
 * `priceMinor / 100` would be WRONG for a currency whose minor unit is not two digits (JPY has
 * none; some currencies have three). `productSummarySchema`'s own doc is explicit that
 * `priceMinor` is "minor units, never a float" and says nothing about which currency uses how
 * many of them — that is exactly what `Intl.NumberFormat`'s `resolvedOptions().
 * maximumFractionDigits` already knows for `currencyCode`'s ISO 4217 minor-unit exponent, so this
 * reads it back rather than assuming two.
 */
/** ISO 4217's own fallback (used by every currency `Intl` does not special-case) — only reached if
 * a runtime's `resolvedOptions()` omits the field entirely, which no environment this app targets
 * actually does; named rather than inlined so the fallback's reasoning is not a bare `2`. */
const DEFAULT_MINOR_UNIT_DIGITS = 2;

export function formatPriceMinor(priceMinor: number, currencyCode: string): string {
  const formatter = new Intl.NumberFormat(undefined, { style: 'currency', currency: currencyCode });
  const minorUnitDigits =
    formatter.resolvedOptions().maximumFractionDigits ?? DEFAULT_MINOR_UNIT_DIGITS;
  const majorUnits = priceMinor / 10 ** minorUnitDigits;
  return formatter.format(majorUnits);
}
