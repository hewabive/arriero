import type { NumaNode } from "@arriero/core";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

import { findDelegatedRootPath, parseSelfCgroupV2Path } from "./capability.js";
import { managerEnv } from "../manager-env.js";

const CGROUP_ROOT = "/sys/fs/cgroup";
const INSTANCES_GROUP = "arriero-instances";
const LEGACY_INSTANCES_GROUP = "llama-manager-instances";

export class NumaPinError extends Error {}

export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function buildPinnedShimArgs(
  cgroupProcsPath: string,
  binaryPath: string,
  cliArgs: string[],
): string[] {
  const command = [binaryPath, ...cliArgs].map(shellQuote).join(" ");
  return ["-c", `echo $$ > ${shellQuote(cgroupProcsPath)} && exec ${command}`];
}

function resolveGroupDir(selfCgroupPath: string, group: string): string {
  const root = findDelegatedRootPath(selfCgroupPath);
  if (root) {
    return `${CGROUP_ROOT}${root}/${group}`;
  }

  const selfDir =
    selfCgroupPath === "/" ? CGROUP_ROOT : `${CGROUP_ROOT}${selfCgroupPath}`;
  return `${dirname(selfDir)}/${group}`;
}

export function resolveInstancesGroupDir(
  selfCgroupPath: string,
  override = managerEnv("NUMA_CGROUP_ROOT"),
): string {
  if (override && override.trim()) {
    return override.trim();
  }
  return resolveGroupDir(selfCgroupPath, INSTANCES_GROUP);
}

function readSelfCgroupPath(): string | null {
  try {
    return parseSelfCgroupV2Path(readFileSync("/proc/self/cgroup", "utf8"));
  } catch {
    return null;
  }
}

function instancesGroupDirOrThrow(): string {
  const selfPath = readSelfCgroupPath();
  if (selfPath === null) {
    throw new NumaPinError("cannot resolve own cgroup (cgroup v2 required)");
  }
  return resolveInstancesGroupDir(selfPath);
}

export function instanceCgroupDir(instanceName: string): string | null {
  const selfPath = readSelfCgroupPath();
  if (selfPath === null) {
    return null;
  }
  return `${resolveInstancesGroupDir(selfPath)}/${instanceName}`;
}

export function instanceCgroupExists(instanceName: string): boolean {
  const dir = instanceCgroupDir(instanceName);
  if (!dir) {
    return false;
  }
  try {
    readFileSync(`${dir}/cgroup.procs`, "utf8");
    return true;
  } catch {
    return false;
  }
}

export function applyNumaPin(instanceName: string, node: NumaNode): string {
  const groupDir = instancesGroupDirOrThrow();
  const cgroupDir = `${groupDir}/${instanceName}`;
  try {
    mkdirSync(groupDir, { recursive: true });
    writeFileSync(`${groupDir}/cgroup.subtree_control`, "+cpuset");
    mkdirSync(cgroupDir, { recursive: true });
    writeFileSync(`${cgroupDir}/cpuset.mems`, String(node.id));
    writeFileSync(`${cgroupDir}/cpuset.cpus`, node.cpus);
  } catch (error) {
    throw new NumaPinError(
      `failed to bind ${instanceName} to NUMA node ${node.id}: ${
        (error as Error).message
      }`,
    );
  }
  return cgroupDir;
}

export function removeNumaCgroup(cgroupDir: string | null): void {
  if (!cgroupDir) {
    return;
  }
  try {
    rmdirSync(cgroupDir);
  } catch {
    return;
  }
}

function sweepEmptyChildCgroups(groupDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(groupDir);
  } catch {
    return;
  }
  for (const entry of entries) {
    const dir = `${groupDir}/${entry}`;
    try {
      if (readFileSync(`${dir}/cgroup.procs`, "utf8").trim() === "") {
        rmdirSync(dir);
      }
    } catch {
      continue;
    }
  }
}

export function cleanupOrphanNumaCgroups(): void {
  const selfPath = readSelfCgroupPath();
  if (selfPath === null) {
    return;
  }
  sweepEmptyChildCgroups(resolveInstancesGroupDir(selfPath));
  const legacyGroupDir = resolveGroupDir(selfPath, LEGACY_INSTANCES_GROUP);
  sweepEmptyChildCgroups(legacyGroupDir);
  removeNumaCgroup(legacyGroupDir);
}
