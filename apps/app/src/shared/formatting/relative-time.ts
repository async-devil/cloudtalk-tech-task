/**
 * `shared/formatting` — the "rated N ago" formatter SPEC-0001's slice map names as living in
 * `shared/` (used by both `catalogue`'s S2 card and `product-detail`'s S3 header, neither of
 * which may import the other — the slice-isolation rule is exactly why this is shared kernel
 * code rather than owned by whichever slice needed it first).
 *
 * NARROW CONTRACT, DELIBERATELY. SPEC-0001 rule 13 requires every place the aggregate appears to
 * say when it was computed rather than imply it is live, and rule 14 says a product with no
 * reviews has no average at all. That "no average" case is therefore `ratingComputedAt === null`
 * on the wire (SPEC-0003), and every caller branches on that BEFORE reaching this function — S2
 * and S3 render "No reviews yet" in that branch instead of calling `formatComputedAt` at all. This
 * function's input type is a plain `string`, not `string | null`, on purpose: a null case here
 * would be unreachable dead code duplicating a decision the caller already made, and ADR-0004's
 * "parse at boundaries, trust types inside" is exactly this — `computedAt` is trusted to be a
 * real ISO-8601 timestamp already validated by the wire schema, not re-validated here.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

function plural(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? '' : 's'} ago`;
}

/**
 * Renders an ISO-8601 timestamp as "N ago" copy — "2 minutes ago", "an hour ago" is deliberately
 * NOT special-cased (SPEC-0001 asks for honesty about staleness, not prose polish, and "1 hours
 * ago" reading slightly stiff is the smaller cost).
 *
 * `now` is an injected second parameter, defaulting to `new Date()`, purely so the unit test can
 * pin a fixed instant instead of racing the wall clock — the same reason every other pure-function
 * time formatter in this repo takes its "now" as a parameter rather than reading it internally.
 */
export function formatComputedAt(computedAt: string, now: Date = new Date()): string {
  const elapsedMs = Math.max(0, now.getTime() - Date.parse(computedAt));

  if (elapsedMs < MINUTE_MS) {
    return 'just now';
  }
  if (elapsedMs < HOUR_MS) {
    return plural(Math.floor(elapsedMs / MINUTE_MS), 'minute');
  }
  if (elapsedMs < DAY_MS) {
    return plural(Math.floor(elapsedMs / HOUR_MS), 'hour');
  }
  return plural(Math.floor(elapsedMs / DAY_MS), 'day');
}
