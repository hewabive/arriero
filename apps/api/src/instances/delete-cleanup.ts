import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { logger } from "../logger.js";
import { instanceLogFilePattern } from "../process/log-paths.js";
import { traceBlockingSection } from "../system/event-loop.js";
import { rewriteLocalRpcWorkerRefs } from "./config-files.js";

function removeSlotsDir(name: string): void {
  const dir = resolve(config.slotsDir, name);
  try {
    traceBlockingSection("instances:rm-slots", () =>
      rmSync(dir, { recursive: true, force: true }),
    );
  } catch (error) {
    logger.warn(
      { err: error, dir },
      "instance delete: slots directory removal failed",
    );
  }
}

function removeLogFiles(name: string, recordedPaths: string[]): void {
  const paths = new Set(recordedPaths);
  const filePattern = instanceLogFilePattern(name);
  if (existsSync(config.logsDir)) {
    for (const entry of readdirSync(config.logsDir)) {
      if (filePattern.test(entry)) {
        paths.add(resolve(config.logsDir, entry));
      }
    }
  }
  for (const path of paths) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      logger.warn({ err: error, path }, "instance delete: log removal failed");
    }
  }
}

export function cleanupDeletedInstance(
  name: string,
  recordedLogPaths: string[],
): void {
  rewriteLocalRpcWorkerRefs(name, () => null);
  removeSlotsDir(name);
  removeLogFiles(name, recordedLogPaths);
}
