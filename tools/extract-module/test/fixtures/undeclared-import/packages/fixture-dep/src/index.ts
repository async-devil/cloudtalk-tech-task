// A real workspace package that exists on disk — the fixture's point is that existing is not
// enough. `fixture-consumer` imports this value without ever declaring `@repo/fixture-dep` as a
// `workspace:*` dependency, which is exactly the undeclared-import shape the extraction proof
// must catch.
export const fixtureDepValue = 'fixture-dep';
