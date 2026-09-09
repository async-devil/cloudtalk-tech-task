export function ok(x: unknown) {
  // biome-ignore lint/suspicious/noExplicitAny: fixture constraint reason
  const y = x as any;
  return y;
}

export function alsoOk() {
  // @ts-expect-error — fixture: this line intentionally fails to typecheck for the reason above
  const n: number = 'not a number';
  return n;
}
