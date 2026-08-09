import { existsSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { logger } from "../logger.js";
import { listInstanceRecords, writeInstanceRecord } from "./config-files.js";

function removeRpcWorkerRefs(name: string): void {
  const referencesInstance = (ref: {
    nodeId: string | null;
    instanceName: string;
  }) => !ref.nodeId && ref.instanceName === name;
  for (const record of listInstanceRecords()) {
    if (!record.rpcWorkers.some(referencesInstance)) {
      continue;
    }
    writeInstanceRecord({
      ...record,
      rpcWorkers: record.rpcWorkers.filter((ref) => !referencesInstance(ref)),
    });
  }
}

function removeSlotsDir(name: string): void {
  const dir = resolve(config.slotsDir, name);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    logger.warn(
      { err: error, dir },
      "instance delete: slots directory removal failed",
    );
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeLogFiles(name: string, recordedPaths: string[]): void {
  const paths = new Set(recordedPaths);
  const filePattern = new RegExp(
    `^${escapeRegExp(name)}-\\d+\\.(?:raw\\.)?log$`,
  );
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
  removeRpcWorkerRefs(name);
  removeSlotsDir(name);
  removeLogFiles(name, recordedLogPaths);
}
