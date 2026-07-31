import type {
  BeeGfsFilesystem,
  BeeGfsResources,
  BeeGfsTarget,
} from "@arriero/core";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { delimiter, dirname } from "node:path";
import { promisify } from "node:util";

import { wellKnownToolDirectories } from "../prerequisites/search-paths.js";
import {
  installCommandPrefix,
  packageManagerForOsRelease,
  readOsRelease,
} from "./os-release.js";
import { probeAnyExecutable } from "./tool-probe.js";

const execFileAsync = promisify(execFile);
const BEEGFS_CACHE_MS = 30_000;
const BEEGFS_COMMAND_TIMEOUT_MS = 10_000;
const GIB_BYTES = 1024 ** 3;
const MILLION = 1_000_000;

export type BeeGfsMount = {
  mountPath: string;
  source: string;
};

function decodeMountField(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_, code: string) => {
    if (code === "040") return " ";
    if (code === "011") return "\t";
    if (code === "012") return "\n";
    return "\\";
  });
}

export function parseBeeGfsMountInfo(contents: string): BeeGfsMount[] {
  const mounts = new Map<string, BeeGfsMount>();
  for (const line of contents.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length < separator + 3) {
      continue;
    }
    const fsType = fields[separator + 1];
    if (!fsType?.startsWith("beegfs")) {
      continue;
    }
    const mountPath = decodeMountField(fields[4]!);
    mounts.set(mountPath, {
      mountPath,
      source: decodeMountField(fields[separator + 2]!),
    });
  }
  return [...mounts.values()].sort((a, b) =>
    a.mountPath.localeCompare(b.mountPath),
  );
}

function readBeeGfsMounts(): BeeGfsMount[] {
  if (process.platform !== "linux") {
    return [];
  }
  try {
    return parseBeeGfsMountInfo(readFileSync("/proc/self/mountinfo", "utf8"));
  } catch {
    return [];
  }
}

function nullableNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return Math.round(value);
  }
  if (typeof value === "string" && value !== "" && value !== "-") {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : null;
  }
  return null;
}

function nullableLabel(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const label = value.trim();
  return label && label !== "(n/a)" && label !== "-" ? label : null;
}

function v8Kind(value: unknown, id: unknown): BeeGfsTarget["kind"] | null {
  const raw = typeof value === "string" ? value.toLowerCase() : value;
  if (raw === 2 || raw === "2" || raw === "meta" || raw === "metadata") {
    return "metadata";
  }
  if (raw === 3 || raw === "3" || raw === "storage") {
    return "storage";
  }
  if (id && typeof id === "object") {
    return v8Kind((id as Record<string, unknown>).node_type, null);
  }
  return null;
}

function v8TargetId(value: unknown, kind: BeeGfsTarget["kind"]): string | null {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (value && typeof value === "object") {
    const numId = (value as Record<string, unknown>).num_id;
    if (typeof numId === "string" || typeof numId === "number") {
      return `${kind === "metadata" ? "m" : "s"}:${numId}`;
    }
  }
  return null;
}

export function parseBeeGfsV8Targets(contents: string): BeeGfsTarget[] {
  const parsed: unknown = JSON.parse(contents);
  if (!Array.isArray(parsed)) {
    throw new Error("BeeGFS returned an unexpected JSON document");
  }

  const targets: BeeGfsTarget[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const row = item as Record<string, unknown>;
    const kind = v8Kind(row.type, row.id);
    if (!kind) {
      continue;
    }
    const id = v8TargetId(row.id, kind);
    if (!id) {
      continue;
    }
    targets.push({
      id,
      alias: nullableLabel(row.alias),
      node: nullableLabel(row.node),
      kind,
      storagePool: nullableLabel(row.storage_pool),
      capacityPool: nullableLabel(row.cap_pool)?.toLowerCase() ?? null,
      totalBytes: nullableNumber(row.space),
      freeBytes: nullableNumber(row.space_free),
      totalInodes: nullableNumber(row.inodes),
      freeInodes: nullableNumber(row.inodes_free),
    });
  }
  return targets;
}

export function parseBeeGfsLegacyTargets(contents: string): BeeGfsTarget[] {
  const targets: BeeGfsTarget[] = [];
  let kind: BeeGfsTarget["kind"] | null = null;
  for (const line of contents.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "METADATA SERVERS:") {
      kind = "metadata";
      continue;
    }
    if (trimmed === "STORAGE TARGETS:") {
      kind = "storage";
      continue;
    }
    if (!kind) {
      continue;
    }
    const match =
      /^\s*(\d+)\s+(\S+)\s+([0-9.]+)GiB\s+([0-9.]+)GiB\s+\d+%\s+([0-9.]+)M\s+([0-9.]+)M\s+\d+%/.exec(
        line,
      );
    if (!match) {
      continue;
    }
    targets.push({
      id: match[1]!,
      alias: null,
      node: null,
      kind,
      storagePool: null,
      capacityPool: match[2]!.toLowerCase(),
      totalBytes: Math.round(Number(match[3]) * GIB_BYTES),
      freeBytes: Math.round(Number(match[4]) * GIB_BYTES),
      totalInodes: Math.round(Number(match[5]) * MILLION),
      freeInodes: Math.round(Number(match[6]) * MILLION),
    });
  }
  return targets;
}

function readBeeGfsClientVersion(): string | null {
  try {
    const version = readFileSync("/sys/module/beegfs/version", "utf8").trim();
    return version || null;
  } catch {
    return null;
  }
}

export function beeGfsToolsPackage(version: string | null): string {
  return version && /^8(?:\.|$)/.test(version)
    ? "beegfs-tools"
    : "beegfs-utils";
}

function installCommand(packageName: string): string | null {
  const manager = packageManagerForOsRelease(readOsRelease());
  const prefix = installCommandPrefix(manager);
  return prefix ? `${prefix} ${packageName}` : null;
}

function errorMessage(error: unknown): string {
  if (error && typeof error === "object") {
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === "string" && stderr.trim()) {
      return stderr.trim().split("\n").slice(-3).join("\n").slice(-2_000);
    }
  }
  return (error instanceof Error ? error.message : String(error)).slice(-2_000);
}

async function queryFilesystem(
  tool: NonNullable<BeeGfsResources["tool"]>,
  executable: string,
  mount: BeeGfsMount,
): Promise<BeeGfsFilesystem> {
  const args =
    tool === "beegfs-df"
      ? ["-p", mount.mountPath]
      : [
          "--mount",
          mount.mountPath,
          "--raw",
          "--output",
          "json",
          "--columns",
          "id,type,alias,node,storage_pool,cap_pool,space,space_free,inodes,inodes_free",
          "target",
          "list",
          "--capacity",
        ];
  try {
    const { stdout } = await execFileAsync(executable, args, {
      encoding: "utf8",
      timeout: BEEGFS_COMMAND_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: {
        ...process.env,
        LC_ALL: "C",
        PATH: [dirname(executable), process.env.PATH ?? ""]
          .filter(Boolean)
          .join(delimiter),
      },
    });
    return {
      ...mount,
      targets:
        tool === "beegfs-df"
          ? parseBeeGfsLegacyTargets(stdout)
          : parseBeeGfsV8Targets(stdout),
      error: null,
    };
  } catch (error) {
    return {
      ...mount,
      targets: [],
      error: errorMessage(error),
    };
  }
}

async function probeBeeGfsResources(): Promise<BeeGfsResources | null> {
  const mounts = readBeeGfsMounts();
  if (mounts.length === 0) {
    return null;
  }

  const clientVersion = readBeeGfsClientVersion();
  const probe = await probeAnyExecutable(["beegfs-df", "beegfs"], {
    extraDirectories: [
      ...wellKnownToolDirectories(),
      "/opt/beegfs/bin",
      "/opt/beegfs/sbin",
    ],
    versionArgs: null,
  });
  if (!probe.found || !probe.name) {
    const requiredPackage = beeGfsToolsPackage(clientVersion);
    return {
      checkedAt: new Date().toISOString(),
      status: "missing-tool",
      tool: null,
      clientVersion,
      requiredPackage,
      installCommand: installCommand(requiredPackage),
      filesystems: mounts.map((mount) => ({
        ...mount,
        targets: [],
        error: null,
      })),
      error: null,
    };
  }

  const tool = probe.name as NonNullable<BeeGfsResources["tool"]>;
  const filesystems = await Promise.all(
    mounts.map((mount) => queryFilesystem(tool, probe.found!, mount)),
  );
  const failed = filesystems.filter((filesystem) => filesystem.error);
  return {
    checkedAt: new Date().toISOString(),
    status: failed.length === filesystems.length ? "error" : "ready",
    tool,
    clientVersion,
    requiredPackage: null,
    installCommand: null,
    filesystems,
    error:
      failed.length === filesystems.length
        ? "BeeGFS capacity could not be read from any mounted filesystem."
        : null,
  };
}

let cached: { expiresAt: number; value: BeeGfsResources | null } | null = null;
let pending: Promise<BeeGfsResources | null> | null = null;

export async function getBeeGfsResources(): Promise<BeeGfsResources | null> {
  const now = Date.now();
  if (cached && cached.expiresAt > now) {
    return cached.value;
  }
  if (pending) {
    return pending;
  }
  pending = probeBeeGfsResources()
    .then((value) => {
      cached = { expiresAt: Date.now() + BEEGFS_CACHE_MS, value };
      return value;
    })
    .finally(() => {
      pending = null;
    });
  return pending;
}
