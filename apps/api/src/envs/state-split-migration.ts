import {
  ENVIRONMENT_MACHINE_STATE_KEYS,
  EnvironmentMachineStateSchema,
  stripKeys,
} from "@arriero/core";
import { existsSync } from "node:fs";

import { readRawArray, writeRawJson } from "../migrations/raw-json.js";
import {
  ENVIRONMENTS_FILE,
  ENVIRONMENTS_STATE_FILE,
  environmentRowsHaveMachineKeys,
  resetEnvironmentRepository,
} from "./repository.js";

function envsFileHasMachineKeys(): boolean {
  return environmentRowsHaveMachineKeys(readRawArray(ENVIRONMENTS_FILE));
}

export function envsStateSplitApplied(): boolean {
  return existsSync(ENVIRONMENTS_STATE_FILE) || !envsFileHasMachineKeys();
}

export function splitEnvironmentMachineState(): void {
  const rows = readRawArray(ENVIRONMENTS_FILE);
  if (!rows) return;
  if (!existsSync(ENVIRONMENTS_STATE_FILE)) {
    const timestamp = new Date().toISOString();
    const entries = rows.flatMap((row) => {
      if (typeof row.id !== "string" || row.id.length === 0) {
        return [];
      }
      return [
        {
          envId: row.id,
          pathCatalogEntryId:
            typeof row.pathCatalogEntryId === "string"
              ? row.pathCatalogEntryId
              : null,
          createdAt:
            typeof row.createdAt === "string" ? row.createdAt : timestamp,
          updatedAt:
            typeof row.updatedAt === "string" ? row.updatedAt : timestamp,
        },
      ];
    });
    writeRawJson(
      ENVIRONMENTS_STATE_FILE,
      EnvironmentMachineStateSchema.parse(entries),
    );
  }
  const portable = rows.map((row) =>
    stripKeys(row, ENVIRONMENT_MACHINE_STATE_KEYS),
  );
  writeRawJson(ENVIRONMENTS_FILE, portable);
  resetEnvironmentRepository();
}
