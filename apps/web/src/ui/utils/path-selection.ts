export function withPaths(
  selection: ReadonlySet<string>,
  paths: Iterable<string>,
  checked: boolean,
): ReadonlySet<string> {
  const next = new Set(selection);
  for (const path of paths) {
    if (checked) {
      next.add(path);
    } else {
      next.delete(path);
    }
  }
  return next;
}
