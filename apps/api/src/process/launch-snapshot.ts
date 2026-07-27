import {
  engineDescriptor,
  InstanceNumaSchema,
  type Instance,
  type InstanceArgs,
  type InstanceNuma,
  type RpcWorkerRef,
} from "@arriero/core";
import { dirname, resolve } from "node:path";

import { config } from "../config.js";
import { engineArgvBuilder } from "./argv.js";

function argIsSet(args: InstanceArgs, key: string): boolean {
  const value = args[key];
  if (value === undefined || value === null || value === false) {
    return false;
  }
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return true;
}

export function managedSlotSavePath(instance: Instance): string | null {
  if (!engineDescriptor(instance.kind).launch.injectSlotSavePath) {
    return null;
  }
  if (argIsSet(instance.args, "--models-preset")) {
    return null;
  }
  if (argIsSet(instance.args, "--slot-save-path")) {
    return null;
  }
  return resolve(config.slotsDir, instance.name);
}

function effectiveLaunchArgs(instance: Instance): InstanceArgs {
  const engineArgs =
    instance.engineConfig?.type === "ktransformers"
      ? {
          "--model": instance.engineConfig.model,
          "--kt-weight-path": instance.engineConfig.cpuWeights,
          "--kt-method": instance.engineConfig.method,
          ...(instance.engineConfig.servedModelName
            ? { "--served-model-name": instance.engineConfig.servedModelName }
            : {}),
        }
      : {};
  const slotSavePath = managedSlotSavePath(instance);
  if (!slotSavePath) {
    return { ...engineArgs, ...instance.args };
  }
  return {
    ...engineArgs,
    ...instance.args,
    "--slot-save-path": slotSavePath,
  };
}

export type LaunchSnapshot = {
  binaryPath: string;
  cliArgs: string[];
  env: Record<string, string>;
  cwd: string;
  numa: InstanceNuma | null;
  rpcWorkers: RpcWorkerRef[];
};

export function buildLaunchSnapshot(instance: Instance): LaunchSnapshot {
  const buildArgv = engineArgvBuilder(
    engineDescriptor(instance.kind).launch.argv,
  );
  return {
    binaryPath: instance.binaryPath,
    cliArgs: buildArgv(effectiveLaunchArgs(instance), [
      ...engineDescriptor(instance.kind).launch.argvPrefix,
      ...(instance.positionalArgs ?? []),
    ]),
    env: { ...instance.env },
    cwd: instance.cwd ?? dirname(instance.binaryPath),
    numa: instance.numa ?? null,
    rpcWorkers: instance.rpcWorkers,
  };
}

export function serializeLaunchSnapshot(snapshot: LaunchSnapshot): string {
  return JSON.stringify(snapshot);
}

export function parseLaunchSnapshot(
  raw: string | null | undefined,
): LaunchSnapshot | null {
  if (!raw) {
    return null;
  }
  try {
    const value = JSON.parse(raw) as Partial<LaunchSnapshot>;
    if (typeof value.binaryPath !== "string" || !Array.isArray(value.cliArgs)) {
      return null;
    }
    return {
      binaryPath: value.binaryPath,
      cliArgs: value.cliArgs.map(String),
      env:
        value.env && typeof value.env === "object" && !Array.isArray(value.env)
          ? (value.env as Record<string, string>)
          : {},
      cwd:
        typeof value.cwd === "string" ? value.cwd : dirname(value.binaryPath),
      numa: InstanceNumaSchema.safeParse(value.numa).data ?? null,
      rpcWorkers: Array.isArray(value.rpcWorkers) ? value.rpcWorkers : [],
    };
  } catch {
    return null;
  }
}

function sameNuma(left: InstanceNuma | null, right: InstanceNuma | null) {
  if (left === null || right === null) {
    return left === right;
  }
  if (left.mode === "bind") {
    return right.mode === "bind" && left.node === right.node;
  }
  return (
    right.mode === "interleave" &&
    sameStringArray(left.nodes.map(String), right.nodes.map(String))
  );
}

function sameStringArray(left: string[], right: string[]) {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function sameRecord(
  left: Record<string, string>,
  right: Record<string, string>,
) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return (
    sameStringArray(leftKeys, rightKeys) &&
    leftKeys.every((key) => left[key] === right[key])
  );
}

export function hasLaunchSnapshotDrift(
  instance: Instance,
  snapshot: LaunchSnapshot,
): boolean {
  const current = buildLaunchSnapshot(instance);
  return (
    current.binaryPath !== snapshot.binaryPath ||
    current.cwd !== snapshot.cwd ||
    !sameNuma(current.numa, snapshot.numa) ||
    !sameStringArray(current.cliArgs, snapshot.cliArgs) ||
    !sameRecord(current.env, snapshot.env) ||
    !sameRpcWorkers(current.rpcWorkers, snapshot.rpcWorkers)
  );
}

function sameRpcWorkers(left: RpcWorkerRef[], right: RpcWorkerRef[]): boolean {
  return (
    left.length === right.length &&
    left.every(
      (ref, index) =>
        ref.nodeId === right[index]?.nodeId &&
        ref.instanceName === right[index]?.instanceName,
    )
  );
}
