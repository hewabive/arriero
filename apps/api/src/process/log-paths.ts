import { escapeRegExp } from "@arriero/core";
import { resolve } from "node:path";

export function runLogPaths(
  dir: string,
  name: string,
  startedAtMs: number,
): { logPath: string; rawLogPath: string } {
  const base = resolve(dir, `${name}-${startedAtMs}`);
  return { logPath: `${base}.log`, rawLogPath: `${base}.raw.log` };
}

export function runLogFilePattern(name: string): RegExp {
  return new RegExp(`^${escapeRegExp(name)}-\\d+\\.(?:raw\\.)?log$`);
}

export function runLogFileTimestampMs(fileName: string): number | null {
  const match = /^.+-(\d{13})\.(?:raw\.)?log$/.exec(fileName);
  return match?.[1] ? Number(match[1]) : null;
}
