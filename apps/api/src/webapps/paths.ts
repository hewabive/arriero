import { existsSync, renameSync, rm } from "node:fs";
import { resolve, sep } from "node:path";

import { config } from "../config.js";
import { logger } from "../logger.js";

export function webappDataDir(name: string): string {
  return assertWebappPath(resolve(config.webappsDir, name));
}

export function webappLogPaths(
  name: string,
  startedAtMs: number,
): { logPath: string; rawLogPath: string } {
  const base = resolve(config.logsDir, "webapps", `${name}-${startedAtMs}`);
  return { logPath: `${base}.log`, rawLogPath: `${base}.raw.log` };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function webappLogFilePattern(name: string): RegExp {
  return new RegExp(`^${escapeRegExp(name)}-\\d+\\.(?:raw\\.)?log$`);
}

function assertWebappPath(path: string): string {
  const root = resolve(config.webappsDir);
  const resolved = resolve(path);
  if (resolved === root || !resolved.startsWith(`${root}${sep}`)) {
    throw new Error(`webapp path escapes ${root}`);
  }
  return resolved;
}

export function discardWebappDirectory(path: string): boolean {
  const resolved = assertWebappPath(path);
  if (!existsSync(resolved)) {
    return false;
  }
  const trash = `${resolved}.trash-${Date.now()}`;
  renameSync(resolved, trash);
  rm(trash, { recursive: true, force: true }, (error) => {
    if (error) {
      logger.warn(
        { err: error, dir: trash },
        "webapp data directory background removal failed",
      );
    }
  });
  return true;
}
