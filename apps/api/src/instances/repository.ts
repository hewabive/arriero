import type {
  Instance,
  InstanceConfigRecord,
  InstanceCreate,
  InstanceUpdate,
} from "@arriero/core";
import { engineDescriptor, InstanceConfigRecordSchema } from "@arriero/core";
import { getPathCatalogEntry } from "../path-catalog/repository.js";
import { deleteMemoryAssessmentState } from "../memory-assessment/instance-cascade.js";
import {
  deleteProcessRunsForInstance,
  latestProcessRun,
  listProcessRunLogPaths,
} from "../process/runs-repository.js";
import { supervisor } from "../process/supervisor.js";
import {
  getInstanceRecord,
  listInstanceRecords,
  removeInstanceRecord,
  writeInstanceRecord,
} from "./config-files.js";
import { cleanupDeletedInstance } from "./delete-cleanup.js";
import {
  assertInstanceRenameAllowed,
  cascadeInstanceRename,
} from "./rename.js";

export class InstanceNameConflictError extends Error {
  constructor(name: string) {
    super(`instance name already exists: ${name}`);
    this.name = "InstanceNameConflictError";
  }
}

export class InstanceConfigValidationError extends Error {
  constructor(readonly details: unknown) {
    super("instance configuration is invalid");
    this.name = "InstanceConfigValidationError";
  }
}

function validateRecord(record: InstanceConfigRecord): InstanceConfigRecord {
  const parsed = InstanceConfigRecordSchema.safeParse(record);
  if (!parsed.success) {
    throw new InstanceConfigValidationError(parsed.error.flatten());
  }
  return parsed.data;
}

function latestStatus(id: string): Pick<Instance, "status" | "pid"> {
  const latestRun = latestProcessRun(id);
  const knownStatuses = new Set<Instance["status"]>([
    "stopped",
    "starting",
    "running",
    "stopping",
    "exited",
    "stale",
    "error",
  ]);
  const status =
    latestRun && knownStatuses.has(latestRun.status as Instance["status"])
      ? (latestRun.status as Instance["status"])
      : "stopped";
  const pid = latestRun?.pid ? Number(latestRun.pid) : null;
  return {
    status,
    pid: pid && Number.isFinite(pid) ? pid : null,
  };
}

function resolveBinaryPath(record: InstanceConfigRecord): string {
  if (record.binaryPathRefId) {
    const entry = getPathCatalogEntry(record.binaryPathRefId);
    if (entry) {
      return entry.path;
    }
  }
  return record.binaryPath;
}

function toInstance(record: InstanceConfigRecord): Instance {
  const processState = supervisor.getState(record.name);
  const durableState = latestStatus(record.name);

  return {
    name: record.name,
    kind: record.kind,
    binaryPath: resolveBinaryPath(record),
    binaryPathRefId: record.binaryPathRefId ?? "",
    cwd: record.cwd ?? undefined,
    args: record.args,
    ...(record.positionalArgs !== undefined
      ? { positionalArgs: record.positionalArgs }
      : {}),
    env: record.env,
    memory: record.memory,
    rpcWorkers: record.rpcWorkers,
    ...(record.numa !== undefined ? { numa: record.numa } : {}),
    ...(record.engineConfig !== undefined
      ? { engineConfig: record.engineConfig }
      : {}),
    scheduling: record.scheduling ?? {
      evictionPolicy: engineDescriptor(record.kind).defaultEvictionPolicy,
    },
    status: processState?.status ?? durableState.status,
    pid: processState?.pid ?? durableState.pid,
  };
}

export function listInstances(): Instance[] {
  return listInstanceRecords().map(toInstance);
}

export function getInstance(name: string): Instance | null {
  const record = getInstanceRecord(name);
  return record ? toInstance(record) : null;
}

export function createInstance(input: InstanceCreate): Instance {
  if (getInstanceRecord(input.name)) {
    throw new InstanceNameConflictError(input.name);
  }

  const binaryRef = getPathCatalogEntry(input.binaryPathRefId);

  const record: InstanceConfigRecord = {
    name: input.name,
    kind: input.kind,
    binaryPath: binaryRef?.path ?? "",
    binaryPathRefId: input.binaryPathRefId,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
    args: input.args,
    ...(input.positionalArgs !== undefined
      ? { positionalArgs: input.positionalArgs }
      : {}),
    env: input.env,
    memory: input.memory,
    rpcWorkers: input.rpcWorkers,
    ...(input.numa !== undefined ? { numa: input.numa } : {}),
    ...(input.engineConfig !== undefined
      ? { engineConfig: input.engineConfig }
      : {}),
    scheduling: input.scheduling ?? {
      evictionPolicy: engineDescriptor(input.kind).defaultEvictionPolicy,
    },
  };

  const validated = validateRecord(record);
  writeInstanceRecord(validated);
  return toInstance(validated);
}

export function updateInstance(
  name: string,
  input: InstanceUpdate,
): Instance | null {
  const current = getInstanceRecord(name);
  if (!current) {
    return null;
  }

  const nextName = input.name ?? current.name;
  if (nextName !== current.name) {
    if (getInstanceRecord(nextName)) {
      throw new InstanceNameConflictError(nextName);
    }
    assertInstanceRenameAllowed(current.name);
  }

  const nextRefId = input.binaryPathRefId ?? current.binaryPathRefId;
  const binaryRef = nextRefId ? getPathCatalogEntry(nextRefId) : null;
  const nextCwd = input.cwd ?? current.cwd;

  const nextPositionalArgs = input.positionalArgs ?? current.positionalArgs;

  const record: InstanceConfigRecord = {
    name: nextName,
    kind: current.kind,
    binaryPath: binaryRef?.path ?? "",
    ...(nextRefId !== undefined ? { binaryPathRefId: nextRefId } : {}),
    ...(nextCwd !== undefined ? { cwd: nextCwd } : {}),
    args: input.args ?? current.args,
    ...(nextPositionalArgs !== undefined
      ? { positionalArgs: nextPositionalArgs }
      : {}),
    env: input.env ?? current.env,
    memory: input.memory ?? current.memory,
    rpcWorkers: input.rpcWorkers ?? current.rpcWorkers,
    ...(input.numa !== undefined ? { numa: input.numa } : {}),
    ...((input.engineConfig ?? current.engineConfig)
      ? { engineConfig: input.engineConfig ?? current.engineConfig }
      : {}),
    scheduling: input.scheduling ??
      current.scheduling ?? {
        evictionPolicy: engineDescriptor(current.kind).defaultEvictionPolicy,
      },
  };

  const validated = validateRecord(record);
  writeInstanceRecord(validated, current.name);
  cascadeInstanceRename(current.name, validated.name);
  return toInstance(validated);
}

export function deleteInstance(name: string): boolean {
  const recordedLogPaths = listProcessRunLogPaths(name);
  const removed = removeInstanceRecord(name);
  if (removed) {
    deleteProcessRunsForInstance(name);
    deleteMemoryAssessmentState(name);
    cleanupDeletedInstance(name, recordedLogPaths);
  }
  return removed;
}
