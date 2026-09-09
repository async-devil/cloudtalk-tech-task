import { describe, expect, it } from 'vitest';
import { attemptsExhausted, claimReachedCeiling } from '../src/internal/attempts.js';

/**
 * The uniform attempts ceiling (ADR-0007, INV-6) read from its two vantage points.
 *
 * Before the 2026-09-09 review these lived as two inline comparisons — `>` in the claim path,
 * `>=` in the reconciler — that agreed only by accident: the operators differ because the
 * vantages differ, and either side edited alone moves the boundary of the last allowed attempt
 * without the other noticing. What is asserted here is the AGREEMENT, not each operator: for
 * every ceiling, the pass on which the reconciler gives up is the pass on which a claim would.
 */
describe('the attempts ceiling, from both vantage points', () => {
  it.each([1, 2, 3, 5])('allows exactly %i attempts before the claim dead-letters', (ceiling) => {
    // `attemptsAfterClaim` is post-increment: attempt n is claimed as n.
    for (let attempt = 1; attempt <= ceiling; attempt += 1) {
      expect(claimReachedCeiling(attempt, ceiling)).toBe(false);
    }
    expect(claimReachedCeiling(ceiling + 1, ceiling)).toBe(true);
  });

  it.each([
    1, 2, 3, 5,
  ])('the reconciler gives up on exactly the same pass (ceiling %i)', (ceiling) => {
    // `attempts` is the row's count BEFORE this pass ages it, so `attempts` consumed already.
    for (let consumed = 0; consumed < ceiling; consumed += 1) {
      expect(attemptsExhausted(consumed, ceiling)).toBe(false);
    }
    expect(attemptsExhausted(ceiling, ceiling)).toBe(true);
  });

  it.each([1, 2, 3, 5])('the two agree row by row (ceiling %i)', (ceiling) => {
    for (let consumed = 0; consumed <= ceiling + 2; consumed += 1) {
      // A row with `consumed` attempts: the reconciler is deciding whether to age it, and a claim
      // arriving instead would land on attempt `consumed + 1`. Both must reach the same verdict.
      expect(attemptsExhausted(consumed, ceiling)).toBe(claimReachedCeiling(consumed + 1, ceiling));
    }
  });
});
