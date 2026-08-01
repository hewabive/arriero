import type {
  BeeGfsFilesystem,
  BeeGfsResources,
  SystemRdmaActivity,
} from "@arriero/core";
import { readFileSync } from "node:fs";
import { statfs } from "node:fs/promises";

const BEEGFS_CAPACITY_REFRESH_MS = 30_000;

export type BeeGfsMount = {
  mountPath: string;
  source: string;
  cfgFile: string | null;
};

export type BeeGfsCapacity = Pick<
  BeeGfsFilesystem,
  "totalBytes" | "freeBytes" | "totalInodes" | "freeInodes"
>;

type BeeGfsStatFs = {
  bsize: bigint;
  blocks: bigint;
  bavail: bigint;
  files: bigint;
  ffree: bigint;
};

type CachedCapacity = {
  identity: string;
  value: BeeGfsCapacity | null;
  checkedAt: string | null;
  error: string | null;
  refreshAfter: number;
};

type PendingCapacity = {
  identity: string;
  token: symbol;
};

type BeeGfsResourceCacheOptions = {
  readMounts: () => BeeGfsMount[];
  readCapacity: (mountPath: string) => Promise<BeeGfsCapacity>;
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
      cfgFile: cfgFileFromSuperOptions(fields[separator + 3]),
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

function finiteNumber(value: bigint): number | null {
  const converted = Number(value);
  return Number.isFinite(converted) && converted >= 0 ? converted : null;
}

export function capacityFromStatFs(stats: BeeGfsStatFs): BeeGfsCapacity {
  const reportsInodes = stats.files > 0n;
  return {
    totalBytes: finiteNumber(stats.blocks * stats.bsize),
    freeBytes: finiteNumber(stats.bavail * stats.bsize),
    totalInodes: reportsInodes ? finiteNumber(stats.files) : null,
    freeInodes: reportsInodes ? finiteNumber(stats.ffree) : null,
  };
}

async function readCapacity(mountPath: string): Promise<BeeGfsCapacity> {
  return capacityFromStatFs(await statfs(mountPath, { bigint: true }));
}

function mountIdentity(mount: BeeGfsMount): string {
  return `${mount.mountPath}\0${mount.source}\0${mount.cfgFile ?? ""}`;
}

function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(-2_000);
}

export class BeeGfsResourceCache {
  private readonly readMounts: () => BeeGfsMount[];
  private readonly readCapacity: (mountPath: string) => Promise<BeeGfsCapacity>;
  private readonly now: () => number;
  private readonly refreshMs: number;
  private readonly capacities = new Map<string, CachedCapacity>();
  private readonly pending = new Map<string, PendingCapacity>();
  private readonly currentIdentities = new Map<string, string>();

  constructor(options: BeeGfsResourceCacheOptions) {
    this.readMounts = options.readMounts;
    this.readCapacity = options.readCapacity;
    this.now = options.now ?? Date.now;
    this.refreshMs = options.refreshMs ?? BEEGFS_CAPACITY_REFRESH_MS;
  }

  get(rdma: SystemRdmaActivity | null): BeeGfsResources | null {
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

    const filesystems = mounts.map((mount): BeeGfsFilesystem => {
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
    });
    const hasCapacity = filesystems.some(
      (filesystem) => filesystem.totalBytes !== null,
    );
    const allFailed = filesystems.every(
      (filesystem) => filesystem.error !== null,
    );
    const collecting = filesystems.some(
      (filesystem) =>
        filesystem.totalBytes === null && filesystem.error === null,
    );

    return {
      checkedAt: new Date(now).toISOString(),
      status:
        allFailed && !hasCapacity
          ? "error"
          : collecting
            ? "collecting"
            : "ready",
      filesystems,
      rdma,
    };
  }

  private scheduleRefresh(
    mount: BeeGfsMount,
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

const beeGfsResourceCache = new BeeGfsResourceCache({
  readMounts: readBeeGfsMounts,
  readCapacity,
});

export function getBeeGfsResources(
  rdma: SystemRdmaActivity | null,
): BeeGfsResources | null {
  return beeGfsResourceCache.get(rdma);
}
