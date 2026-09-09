import { Button, Card } from '@repo/styles';

/**
 * The type-enforcement WITNESS (ADR-0012).
 *
 * ADR-0012 names two adherence rules for the design system's primitives — "no undeclared prop" and
 * "no out-of-union variant value" — and the mechanism is **the type system, not a scanner**. This
 * file is what makes that verifiable rather than a claim.
 *
 * WHY NOT A SCANNER. TypeScript already rejects both, for every TSX consumer, with a better error
 * than line-matching could produce and with no possibility of the scanner and the compiler
 * disagreeing. Measured against this repo's real config rather than reasoned about: `tsc --noEmit
 * -p apps/app/tsconfig.json` reports `TS2322` for an undeclared prop AND for an out-of-union
 * variant, and nothing for the legitimate call. A duplicate scanner would spend effort to be less
 * correct.
 *
 * WHY THIS FILE IS THE PROOF. `@ts-expect-error` inverts the compiler: the directive is an ERROR
 * unless the line below it actually fails to compile (`TS2578: Unused '@ts-expect-error'
 * directive`). So this file compiles ONLY WHILE the compiler still rejects both violations. Loosen
 * a primitive's typing — widen a prop to `any`, replace `VariantProps` with `Record<string,
 * unknown>`, spread an untyped rest — and `app:typecheck` goes red HERE, naming the property that
 * stopped being enforced.
 *
 * It lives in `apps/app/test/` and not `packages/styles/test/` for two reasons, the second
 * measured: the property is consumer-side ("a CONSUMER cannot pass an undeclared prop"), and
 * `packages/styles`' tsconfig has `rootDir: src` with `composite: true`, so including its `test`
 * directory would emit test files into `dist/` and pollute the extraction proof.
 *
 * There is deliberately no `describe`/`it` here: this is a COMPILE-time assertion. A runtime test
 * body would suggest the enforcement is something vitest checks, which it is not — nothing in this
 * file needs to execute for it to do its job.
 */

export function undeclaredPropIsRejected() {
  return (
    // @ts-expect-error — `foo` is not a declared prop of Button. JSX excess-property checking is
    // what rejects it; if this directive ever reports TS2578 ("unused"), Button's props stopped
    // being closed and any typo is now silently accepted at every call site.
    <Button foo="bar">Save</Button>
  );
}

export function outOfUnionVariantIsRejected() {
  return (
    // @ts-expect-error — "flamboyant" is not in Button's `variant` union. `VariantProps<typeof
    // buttonVariants>` is what narrows it to the literal union; if this goes unused, the variant
    // vocabulary is no longer a closed set and a misspelt variant renders as the default.
    <Button variant="flamboyant">Save</Button>
  );
}

export function outOfUnionSizeIsRejected() {
  return (
    // @ts-expect-error — "enormous" is not in Button's `size` union. Asserted separately from
    // `variant` because the two axes come from different parts of the CVA config and can regress
    // independently.
    <Button size="enormous">Save</Button>
  );
}

export function undeclaredPropOnANonVariantPrimitiveIsRejected() {
  return (
    // @ts-expect-error — Card takes no `elevation` prop. A vendored primitive's own variant system
    // is the only place a visual axis like this may live; a stray prop bolted on beside it must
    // not compile.
    <Card elevation="raised">Content</Card>
  );
}

/**
 * The control. Every directive above is only meaningful if a LEGITIMATE call still compiles — a
 * file where everything failed would satisfy all four `@ts-expect-error`s while proving the
 * primitives had become unusable. Deliberately carries no directive: if this line ever fails,
 * `app:typecheck` reports it directly.
 */
export function legitimateUsageStillCompiles() {
  return (
    <Card>
      <Button variant="destructive" size="sm" type="submit">
        Delete
      </Button>
    </Card>
  );
}
