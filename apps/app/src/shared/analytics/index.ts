/**
 * `shared/analytics` — the thin, provider-optional analytics wrapper (ADR-0012).
 *
 * Features import THIS, never a vendor SDK. Swapping PostHog for something else is then two files
 * (this one and the composition root that wires it), not a grep across every feature; and a
 * product that wires no provider at all still compiles, still renders, and still has call sites
 * that read as intent.
 */

/** A provider adapter — the shape a PostHog/Segment/whatever binding implements. Keeping it a
 * plain function means the browser snippet stays in `main.tsx` (the composition root, ADR-0005),
 * and no vendor type reaches a feature. */
export type AnalyticsSink = (name: string, properties: Readonly<Record<string, unknown>>) => void;

let sink: AnalyticsSink | undefined;

/**
 * Wires the provider. Called once, from the composition root (`main.tsx`), by a product that has
 * one; absent ⇒ every `track` is a no-op, which is this repository's shipped state — no analytics
 * vendor is chosen here, and inventing one would be inventing a product decision. Returns a
 * teardown so a test can restore the unwired state.
 */
export function setAnalyticsSink(next: AnalyticsSink | undefined): () => void {
  const previous = sink;
  sink = next;
  return () => {
    sink = previous;
  };
}

export const analytics = {
  /**
   * Records a product event. Never throws and never rejects: analytics is not allowed to break a
   * user flow, so a provider that blows up is swallowed here — deliberately WITHOUT logging,
   * because a logging call in a hot UI path is its own failure mode and this is not one of
   * ADR-0009's boundaries.
   *
   * Synchronous by signature on purpose: an `await`ed analytics call on a request path is the
   * unbounded-fail-open shape that a logging call in a hot path would also be. Adapters that talk
   * to the network fire and forget inside their own implementation.
   */
  track(name: string, properties: Readonly<Record<string, unknown>> = {}): void {
    if (sink === undefined) {
      return;
    }
    try {
      sink(name, properties);
    } catch {
      // Intentionally ignored — see above.
    }
  },
};
