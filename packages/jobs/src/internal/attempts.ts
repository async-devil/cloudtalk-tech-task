/**
 * The uniform attempts ceiling (ADR-0007), expressed ONCE.
 *
 * Two vantage points read the same ceiling and used to spell it differently (review, 2026-09-09):
 * `claimStage`/`runPipelineBranch` compare the value their claim UPDATE returned — this attempt
 * already counted — with `>`, while the reconciler compares the row's current count, before the
 * pass ages it, with `>=`. The two agree today only because the off-by-one in the vantage point
 * exactly cancels the off-by-one in the operator; either side edited alone silently moves the
 * boundary of the last allowed attempt, and which path observes a row first then decides whether
 * that attempt happens at all. Both now call the same predicate through the adapter that names
 * their vantage, so the boundary is one line and the vantage is explicit at the call site.
 *
 * The rule, stated once: a unit gets at most `ceiling` attempts, then dead-letters.
 */
function hasAttemptsRemaining(consumedAttempts: number, ceiling: number): boolean {
  return consumedAttempts < ceiling;
}

/**
 * Claim-side: `attemptsAfterClaim` is the value the claim UPDATE returned, so the attempt being
 * claimed is already included in it. True when the claim consumed more than the ceiling allows —
 * the caller dead-letters instead of running the stage/branch.
 */
export function claimReachedCeiling(attemptsAfterClaim: number, ceiling: number): boolean {
  return !hasAttemptsRemaining(attemptsAfterClaim - 1, ceiling);
}

/**
 * Reconciler-side: `attempts` is the row's current count, before this pass ages it. True when no
 * attempt is left to age into — the caller dead-letters instead of re-driving.
 */
export function attemptsExhausted(attempts: number, ceiling: number): boolean {
  return !hasAttemptsRemaining(attempts, ceiling);
}
