import { existsSync, readFileSync } from "node:fs";

import { atomicWriteFile } from "../utils/atomic-write.js";

export function readRawArray(path: string): Record<string, unknown>[] | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null;
  } catch {
    return null;
  }
}

export function writeRawJson(path: string, value: unknown): void {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
