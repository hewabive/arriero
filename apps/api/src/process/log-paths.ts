import { resolve } from "node:path";

export function runLogPaths(
  dir: string,
  name: string,
  startedAtMs: number,
): { logPath: string; rawLogPath: string } {
  const base = resolve(dir, `${name}-${startedAtMs}`);
  return { logPath: `${base}.log`, rawLogPath: `${base}.raw.log` };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function runLogFilePattern(name: string): RegExp {
  return new RegExp(`^${escapeRegExp(name)}-\\d+\\.(?:raw\\.)?log$`);
}
