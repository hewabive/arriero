import { isAbsolute, relative, sep } from "node:path";

export function isPathWithin(parent: string, candidate: string): boolean {
  const child = relative(parent, candidate);
  return (
    child === "" ||
    (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  );
}
