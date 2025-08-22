export function shallowEqualParams(a: Record<string, any>, b: Record<string, any>) {
  const ak = Object.keys(a ?? {}), bk = Object.keys(b ?? {});
  if (ak.length !== bk.length) return false;
  for (const k of ak) if (a[k] !== b[k]) return false;
  return true;
}