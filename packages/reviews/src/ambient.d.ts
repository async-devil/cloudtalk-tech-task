/**
 * Minimal hand-written ambient declaration for the one Node surface this package's cursor codec
 * uses (`internal/cursor.ts`'s base64url encode/decode) — no `@types/node` dependency (no
 * registry entry), following the declare-only-what-you-use pattern of
 * `packages/config/src/ambient.d.ts`, `packages/persistence/src/ambient.d.ts` and
 * `tools/arch-checks/src/ambient.d.ts`. Scoped to exactly the two calls made today
 * (`Buffer.from(str, 'utf8').toString('base64url')` and its reverse); widen it only when this
 * package starts using more of the surface.
 */
/**
 * The instance shape, declared as an interface rather than inlined into {@link Buffer}'s return
 * type, because `Buffer` is used as a TYPE as well as a value in this package — the container
 * suite's `spawn-relay-probe.ts` annotates stream chunks `(chunk: Buffer)`. A value-only
 * `declare const` leaves that annotation resolving to something with a zero-argument `toString`,
 * which turns every `chunk.toString('utf8')` into `TS2554: Expected 0 arguments, but got 1` —
 * invisible to CI, because nothing typechecks `test-integration/`.
 *
 * `encoding` is optional here for the same reason: a stream chunk is decoded with an explicit
 * encoding, while the cursor codec's own calls always pass one.
 */
interface Buffer {
  toString(encoding?: 'utf8' | 'base64url'): string;
}

declare const Buffer: {
  from(input: string, encoding: 'utf8' | 'base64url'): Buffer;
};
