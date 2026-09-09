export function bad(x: unknown) {
  const y = x as any;
  // @ts-ignore
  return y.whatever;
}
