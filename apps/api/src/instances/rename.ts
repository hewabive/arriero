import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { logger } from "../logger.js";
import { renameMemoryAssessmentInstance } from "../memory-assessment/repository.js";
import {
  openProcessRunForInstance,
  renameProcessRunsInstance,
} from "../process/runs-repository.js";
import { supervisor } from "../process/supervisor.js";
import { renameApiProxyInstanceEndpointRefs } from "../proxy/repository.js";
import { listInstanceRecords, writeInstanceRecord } from "./config-files.js";

export class InstanceRenameBlockedError extends Error {
  constructor(name: string, status: string) {
    super(`stop instance ${name} before renaming it (status: ${status})`);
    this.name = "InstanceRenameBlockedError";
  }
}

export function assertInstanceRenameAllowed(name: string): void {
  const runtime = supervisor.getState(name);
  if (runtime && ["starting", "running", "stopping"].includes(runtime.status)) {
    throw new InstanceRenameBlockedError(name, runtime.status);
  }
  const openRun = openProcessRunForInstance(name);
  if (openRun) {
    throw new InstanceRenameBlockedError(name, openRun.status);
  }
}

function renameRpcWorkerRefs(from: string, to: string): void {
  const referencesFrom = (ref: {
    nodeId: string | null;
    instanceName: string;
  }) => !ref.nodeId && ref.instanceName === from;
  for (const record of listInstanceRecords()) {
    if (!record.rpcWorkers.some(referencesFrom)) {
      continue;
    }
    writeInstanceRecord({
      ...record,
      rpcWorkers: record.rpcWorkers.map((ref) =>
        referencesFrom(ref) ? { ...ref, instanceName: to } : ref,
      ),
    });
  }
}

function renameSlotsDir(from: string, to: string): void {
  const fromDir = resolve(config.slotsDir, from);
  if (!existsSync(fromDir)) {
    return;
  }
  const toDir = resolve(config.slotsDir, to);
  if (existsSync(toDir)) {
    logger.warn(
      { from: fromDir, to: toDir },
      "instance rename: slots directory move skipped, destination exists",
    );
    return;
  }
  try {
    renameSync(fromDir, toDir);
  } catch (error) {
    logger.warn(
      { err: error, from: fromDir, to: toDir },
      "instance rename: slots directory move failed",
    );
  }
}

export function cascadeInstanceRename(from: string, to: string): void {
  if (from === to) {
    return;
  }
  renameMemoryAssessmentInstance(from, to);
  renameProcessRunsInstance(from, to);
  renameApiProxyInstanceEndpointRefs(from, to);
  renameRpcWorkerRefs(from, to);
  renameSlotsDir(from, to);
}
