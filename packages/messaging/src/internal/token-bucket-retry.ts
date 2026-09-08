/** The retry-delay math, exported PURE so 's unit-pins exactly the formula the Lua
 * embeds — integration proves the two agree against real Redis. */
export function computeTokenBucketRetryAfterMs(state: {
  readonly cost: number;
  readonly refilled: number;
  readonly refillPerSecond: number;
}): number {
  if (state.cost <= state.refilled) {
    return 0;
  }
  return Math.ceil(((state.cost - state.refilled) / state.refillPerSecond) * 1000);
}
