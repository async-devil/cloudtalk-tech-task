// Imports a real sibling workspace package that this file's own package.json never declares as a
// `workspace:*` dependency (see the "//" note there). extractModule's dependency closure is built
// entirely from package.json, so this package is copied out ALONE — `@repo/fixture-dep` never
// travels with it, and this import fails to resolve during the extracted copy's `tsc build`. That
// failure is the proof: an undeclared import fails the run.
import { fixtureDepValue } from '@repo/fixture-dep';

export const consumed = fixtureDepValue;
