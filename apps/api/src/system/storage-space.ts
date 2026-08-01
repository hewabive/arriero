import type {
  SystemRdmaActivity,
  SystemStorageResources,
  SystemStorageSpace,
} from "@arriero/core";
import { readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";

const STORAGE_CAPACITY_REFRESH_MS = 30_000;
const LOCAL_STORAGE_FILESYSTEMS = new Set([
  "bcachefs",
  "btrfs",
  "ext2",
  "ext3",
  "ext4",
  "f2fs",
  "fuseblk",
  "jfs",
  "nilfs2",
  "ntfs",
  "ntfs3",
  "overlay",
  "reiserfs",
  "vfat",
  "xfs",
  "zfs",
]);

export type StorageMount = Pick<
  SystemStorageSpace,
  "mountPath" | "source" | "fsType" | "kind" | "cfgFile"
>;

export type StorageCapacity = Pick<
  SystemStorageSpace,
  "totalBytes" | "freeBytes" | "totalInodes" | "freeInodes"
>;

type StorageStatFs = {
  bsize: bigint;
  blocks: bigint;
  bavail: bigint;
  files: bigint;
  ffree: bigint;
};

type CachedCapacity = {
  identity: string;
  value: StorageCapacity | null;
  checkedAt: string | null;
  error: string | null;
  refreshAfter: number;
};

type PendingCapacity = {
  identity: string;
  token: symbol;
};

type StorageResourceCacheOptions = {
  readMounts: () => StorageMount[];
  readCapacity: (mountPath: string) => Promise<StorageCapacity>;
  now?: () => number;
  refreshMs?: number;
};

function decodeMountField(value: string): string {
  return value.replace(/\\(040|011|012|134)/g, (_, code: string) => {
    if (code === "040") return " ";
    if (code === "011") return "\t";
    if (code === "012") return "\n";
    return "\\";
  });
}

function cfgFileFromSuperOptions(value: string | undefined): string | null {
  const option = value
    ?.split(",")
    .find((entry) => entry.startsWith("cfgFile="));
  return option ? decodeMountField(option.slice("cfgFile=".length)) : null;
}

function storageKind(fsType: string): SystemStorageSpace["kind"] | null {
  if (fsType.startsWith("beegfs")) {
    return "beegfs";
  }
  return LOCAL_STORAGE_FILESYSTEMS.has(fsType) ? "local" : null;
}

export function parseStorageMountInfo(contents: string): StorageMount[] {
  const mounts = new Map<string, StorageMount>();
  for (const line of contents.split("\n")) {
    const fields = line.trim().split(/\s+/);
    const separator = fields.indexOf("-");
    if (separator < 6 || fields.length < separator + 3) {
      continue;
    }
    const fsType = fields[separator + 1]!.toLowerCase();
    const kind = storageKind(fsType);
    if (!kind) {
      continue;
    }
    const mountPath = decodeMountField(fields[4]!);
    mounts.set(mountPath, {
      mountPath,
      source: decodeMountField(fields[separator + 2]!),
      fsType,
      kind,
      cfgFile:
        kind === "beegfs"
          ? cfgFileFromSuperOptions(fields[separator + 3])
          : null,
    });
  }
  return [...mounts.values()].sort((a, b) =>
    a.mountPath.localeCompare(b.mountPath),
  );
}

function readStorageMounts(): StorageMount[] {
  if (process.platform !== "linux") {
    return [];
  }
  try {
    return parseStorageMountInfo(readFileSync("/proc/self/mountinfo", "utf8"));
  } catch {
    return [];
  }
}

function finiteNumber(value: bigint): number | null {
  const converted = Number(value);
  return Number.isFinite(converted) && converted >= 0 ? converted : null;
}

export function capacityFromStatFs(stats: StorageStatFs): StorageCapacity {
  const reportsInodes = stats.files > 0n;
  return {
    totalBytes: finiteNumber(stats.blocks * stats.bsize),
    freeBytes: finiteNumber(stats.bavail * stats.bsize),
    totalInodes: reportsInodes ? finiteNumber(stats.files) : null,
    freeInodes: reportsInodes ? finiteNumber(stats.ffree) : null,
  };
}

async function readCapacity(mountPath: string): Promise<StorageCapacity> {
  return capacityFromStatFs(await statfs(mountPath, { bigint: true }));
}

function mountIdentity(mount: StorageMount): string {
  return [
    mount.mountPath,
    mount.source,
    mount.fsType,
    mount.kind,
    mount.cfgFile ?? "",
  ].join("\0");
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(-2_000);
}

export class StorageResourceCache {
  private readonly readMounts: () => StorageMount[];
  private readonly readCapacity: (
    mountPath: string,
  ) => Promise<StorageCapacity>;
  private readonly now: () => number;
  private readonly refreshMs: number;
  private readonly capacities = new Map<string, CachedCapacity>();
  private readonly pending = new Map<string, PendingCapacity>();
  private readonly currentIdentities = new Map<string, string>();

  constructor(options: StorageResourceCacheOptions) {
    this.readMounts = options.readMounts;
    this.readCapacity = options.readCapacity;
    this.now = options.now ?? Date.now;
    this.refreshMs = options.refreshMs ?? STORAGE_CAPACITY_REFRESH_MS;
  }

  get(rdma: SystemRdmaActivity | null): SystemStorageResources | null {
    const mounts = this.readMounts();
    if (mounts.length === 0) {
      this.currentIdentities.clear();
      this.capacities.clear();
      this.pending.clear();
      return null;
    }

    const activePaths = new Set(mounts.map((mount) => mount.mountPath));
    for (const path of this.capacities.keys()) {
      if (!activePaths.has(path)) {
        this.capacities.delete(path);
      }
    }
    for (const path of this.currentIdentities.keys()) {
      if (!activePaths.has(path)) {
        this.currentIdentities.delete(path);
        this.pending.delete(path);
      }
    }

    const now = this.now();
    for (const mount of mounts) {
      const identity = mountIdentity(mount);
      this.currentIdentities.set(mount.mountPath, identity);
      const cached = this.capacities.get(mount.mountPath);
      if (cached && cached.identity !== identity) {
        this.capacities.delete(mount.mountPath);
      }
      this.scheduleRefresh(mount, identity, now);
    }

    return {
      checkedAt: new Date(now).toISOString(),
      filesystems: mounts.map((mount): SystemStorageSpace => {
        const cached = this.capacities.get(mount.mountPath);
        return {
          ...mount,
          totalBytes: cached?.value?.totalBytes ?? null,
          freeBytes: cached?.value?.freeBytes ?? null,
          totalInodes: cached?.value?.totalInodes ?? null,
          freeInodes: cached?.value?.freeInodes ?? null,
          checkedAt: cached?.checkedAt ?? null,
          error: cached?.error ?? null,
        };
      }),
      rdma: mounts.some((mount) => mount.kind === "beegfs") ? rdma : null,
    };
  }

  private scheduleRefresh(
    mount: StorageMount,
    identity: string,
    now: number,
  ): void {
    const cached = this.capacities.get(mount.mountPath);
    const pending = this.pending.get(mount.mountPath);
    if (
      pending?.identity === identity ||
      (cached && cached.identity === identity && cached.refreshAfter > now)
    ) {
      return;
    }

    const token = Symbol(mount.mountPath);
    const promise = this.readCapacity(mount.mountPath)
      .then((value) => {
        if (
          this.currentIdentities.get(mount.mountPath) !== identity ||
          this.pending.get(mount.mountPath)?.token !== token
        ) {
          return;
        }
        const completedAt = this.now();
        this.capacities.set(mount.mountPath, {
          identity,
          value,
          checkedAt: new Date(completedAt).toISOString(),
          error: null,
          refreshAfter: completedAt + this.refreshMs,
        });
      })
      .catch((error: unknown) => {
        if (
          this.currentIdentities.get(mount.mountPath) !== identity ||
          this.pending.get(mount.mountPath)?.token !== token
        ) {
          return;
        }
        const completedAt = this.now();
        const previous = this.capacities.get(mount.mountPath);
        this.capacities.set(mount.mountPath, {
          identity,
          value: previous?.identity === identity ? previous.value : null,
          checkedAt:
            previous?.identity === identity ? previous.checkedAt : null,
          error: errorMessage(error),
          refreshAfter: completedAt + this.refreshMs,
        });
      })
      .finally(() => {
        if (this.pending.get(mount.mountPath)?.token === token) {
          this.pending.delete(mount.mountPath);
        }
      });
    this.pending.set(mount.mountPath, { identity, token });
    void promise;
  }
}

const storageResourceCache = new StorageResourceCache({
  readMounts: readStorageMounts,
  readCapacity,
});

export function getStorageResources(
  rdma: SystemRdmaActivity | null,
): SystemStorageResources | null {
  return storageResourceCache.get(rdma);
}
