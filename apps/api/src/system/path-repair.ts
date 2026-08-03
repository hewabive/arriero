import { existsSync } from "node:fs";
import { delimiter } from "node:path";

import { wellKnownToolDirectories } from "../prerequisites/search-paths.js";
import { pathEntries } from "./tool-probe.js";

export function missingPathDirectories(
  pathValue: string | undefined,
  candidates: string[],
): string[] {
  const current = new Set(pathEntries(pathValue));
  return candidates.filter(
    (directory) => !current.has(directory) && existsSync(directory),
  );
}

let repaired: string[] = [];

export function augmentProcessPath(
  candidates: string[] = wellKnownToolDirectories(),
): string[] {
  const added = missingPathDirectories(process.env.PATH, candidates);
  if (added.length > 0) {
    process.env.PATH = [...pathEntries(process.env.PATH), ...added].join(
      delimiter,
    );
    repaired = [...new Set([...repaired, ...added])];
  }
  return added;
}

export function autoRepairedPathDirectories(): string[] {
  return [...repaired];
}
