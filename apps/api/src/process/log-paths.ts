import { resolve } from "node:path";

import { config } from "../config.js";

export function instanceLogPaths(
  instanceName: string,
  startedAtMs: number,
): { logPath: string; rawLogPath: string } {
  const base = resolve(config.logsDir, `${instanceName}-${startedAtMs}`);
  return { logPath: `${base}.log`, rawLogPath: `${base}.raw.log` };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function instanceLogFilePattern(instanceName: string): RegExp {
  return new RegExp(`^${escapeRegExp(instanceName)}-\\d+\\.(?:raw\\.)?log$`);
}
