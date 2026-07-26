import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

import { z } from "zod";

import { config } from "../config.js";

const LegacyNumaNodeSchema = z.number().int().min(0);

function instanceConfigFiles(): string[] {
  if (!existsSync(config.instancesDir)) {
    return [];
  }
  return readdirSync(config.instancesDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => resolve(config.instancesDir, entry.name));
}

function readRecord(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function hasLegacyNumaNode(record: Record<string, unknown> | null): boolean {
  return record !== null && Object.hasOwn(record, "numaNode");
}

export function instanceConfigsHaveLegacyNumaNode(): boolean {
  return instanceConfigFiles().some((path) =>
    hasLegacyNumaNode(readRecord(path)),
  );
}

export function migrateInstanceNumaNodeToNuma(): void {
  for (const path of instanceConfigFiles()) {
    const record = readRecord(path);
    if (!hasLegacyNumaNode(record)) {
      continue;
    }
    const node = LegacyNumaNodeSchema.parse(record!.numaNode);
    delete record!.numaNode;
    record!.numa = { mode: "bind", node };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  }
}
