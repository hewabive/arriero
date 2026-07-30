import { readFileSync } from "node:fs";

export function readSysString(path: string): string | null {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value.length > 0 ? value : null;
  } catch {
    return null;
  }
}
