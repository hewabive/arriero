import { isActiveProcessStatus } from "@arriero/core";
import { existsSync, renameSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { logger } from "../logger.js";
import { renameMemoryAssessmentState } from "../memory-assessment/instance-cascade.js";
import {
  openProcessRunForInstance,
  renameProcessRunsInstance,
} from "../process/runs-repository.js";
import { supervisor } from "../process/supervisor.js";
import { renameApiProxyInstanceEndpointRefs } from "../proxy/repository.js";
import { rewriteLocalRpcWorkerRefs } from "./config-files.js";

export class InstanceRenameBlockedError extends Error {
  constructor(name: string, status: string) {
    super(`stop instance ${name} before renaming it (status: ${status})`);
    this.name = "InstanceRenameBlockedError";
  }
}

export function assertInstanceRenameAllowed(name: string): void {
  const runtime = supervisor.getState(name);
  if (runtime && isActiveProcessStatus(runtime.status)) {
    throw new InstanceRenameBlockedError(name, runtime.status);
  }
  const openRun = openProcessRunForInstance(name);
  if (openRun) {
    throw new InstanceRenameBlockedError(name, openRun.status);
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
  renameMemoryAssessmentState(from, to);
  renameProcessRunsInstance(from, to);
  renameApiProxyInstanceEndpointRefs(from, to);
  rewriteLocalRpcWorkerRefs(from, (ref) => ({ ...ref, instanceName: to }));
  renameSlotsDir(from, to);
}
