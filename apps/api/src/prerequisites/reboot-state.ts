import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { readSysString } from "../system/sysfs.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { readValidatedJsonFile } from "../utils/json-file.js";

const BOOT_ID_PATH = "/proc/sys/kernel/random/boot_id";

const RebootMarkerSchema = z.object({
  checkId: z.string(),
  bootId: z.string(),
  installedAt: z.string(),
});

type RebootMarker = z.infer<typeof RebootMarkerSchema>;

export class PrerequisiteRebootState {
  constructor(
    private readonly path = resolve(
      config.dataDir,
      "prerequisite-reboot-state.json",
    ),
    private readonly readBootId: () => string | null = () =>
      readSysString(BOOT_ID_PATH),
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
      installedAt: new Date().toISOString(),
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
    const markers = readValidatedJsonFile(
      this.path,
      z.array(RebootMarkerSchema),
      "prerequisite reboot state",
    );
    return new Map((markers ?? []).map((marker) => [marker.checkId, marker]));
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
