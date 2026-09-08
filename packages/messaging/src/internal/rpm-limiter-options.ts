const SECONDS_PER_MINUTE = 60;

/** Maps `requestsPerMinute` to the underlying token-bucket parameters (-pinned
 * invariant): `capacity = requestsPerMinute`, `refillPerSecond = requestsPerMinute / 60` —
 * factored out as a pure function so the mapping is unit-testable without a live Redis
 * connection. */
export function rpmLimiterOptions(requestsPerMinute: number): {
  readonly capacity: number;
  readonly refillPerSecond: number;
} {
  return { capacity: requestsPerMinute, refillPerSecond: requestsPerMinute / SECONDS_PER_MINUTE };
}
