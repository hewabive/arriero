import { EnvironmentMachineStateSchema } from "@arriero/core";
import { existsSync } from "node:fs";

import { readRawArray, writeRawJson } from "../migrations/raw-json.js";
import {
  ENVIRONMENTS_FILE,
  ENVIRONMENTS_STATE_FILE,
  resetEnvironmentRepository,
} from "./repository.js";

const ENVIRONMENT_MACHINE_STATE_KEYS = [
  "pathCatalogEntryId",
  "createdAt",
  "updatedAt",
] as const;

export function environmentRowsHaveMachineKeys(json: unknown): boolean {
  return (
    Array.isArray(json) &&
    json.some(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        ENVIRONMENT_MACHINE_STATE_KEYS.some((key) => key in row),
    )
  );
}

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
  const portable = rows.map((row) => {
    const rest = { ...row };
    for (const key of ENVIRONMENT_MACHINE_STATE_KEYS) {
      delete rest[key];
    }
    return rest;
  });
  writeRawJson(ENVIRONMENTS_FILE, portable);
  resetEnvironmentRepository();
}
