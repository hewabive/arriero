import { resolve, sep } from "node:path";

export function assertPathWithinRoot(
  root: string,
  path: string,
  label: string,
): string {
  const resolvedRoot = resolve(root);
  const resolved = resolve(path);
  if (
    resolved === resolvedRoot ||
    !resolved.startsWith(`${resolvedRoot}${sep}`)
  ) {
    throw new Error(`${label} path escapes ${resolvedRoot}`);
  }
  return resolved;
}
