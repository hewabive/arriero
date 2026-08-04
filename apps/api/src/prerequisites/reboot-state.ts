import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { readSysString } from "../system/sysfs.js";
import { atomicWriteFile } from "../utils/atomic-write.js";

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

type RebootMarker = {
  checkId: string;
  bootId: string;
  installedAt: string;
};

function isRebootMarker(value: unknown): value is RebootMarker {
  if (!value || typeof value !== "object") {
    return false;
  }
  const marker = value as Partial<RebootMarker>;
  return (
    typeof marker.checkId === "string" &&
    typeof marker.bootId === "string" &&
    typeof marker.installedAt === "string"
  );
}

export class PrerequisiteRebootState {
  constructor(
    private readonly path = resolve(
      config.dataDir,
      "prerequisite-reboot-state.json",
    ),
    private readonly readBootId: () => string | null = () =>
      readSysString(BOOT_ID_PATH),
    private readonly now: () => Date = () => new Date(),
  ) {}

  isPending(checkId: string): boolean {
    const markers = this.load();
    const marker = markers.get(checkId);
    if (!marker) {
      return false;
    }
    const bootId = this.readBootId();
    if (!bootId || marker.bootId === bootId) {
      return true;
    }
    markers.delete(checkId);
    this.persist(markers);
    return false;
  }

  markPending(checkId: string): void {
    const bootId = this.readBootId();
    if (!bootId) {
      throw new Error("the current Linux boot ID is unavailable");
    }
    const markers = this.load();
    markers.set(checkId, {
      checkId,
      bootId,
      installedAt: this.now().toISOString(),
    });
    this.persist(markers);
  }

  clear(checkId: string): void {
    const markers = this.load();
    if (markers.delete(checkId)) {
      this.persist(markers);
    }
  }

  private load(): Map<string, RebootMarker> {
    if (!existsSync(this.path)) {
      return new Map();
    }
    try {
      const value = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(value)) {
        return new Map();
      }
      return new Map(
        value.filter(isRebootMarker).map((marker) => [marker.checkId, marker]),
      );
    } catch {
      return new Map();
    }
  }

  private persist(markers: Map<string, RebootMarker>): void {
    if (markers.size === 0) {
      rmSync(this.path, { force: true });
      return;
    }
    atomicWriteFile(
      this.path,
      `${JSON.stringify([...markers.values()], null, 2)}\n`,
    );
  }
}

export const prerequisiteRebootState = new PrerequisiteRebootState();
