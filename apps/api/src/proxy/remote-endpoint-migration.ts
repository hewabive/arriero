import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { config } from "../config.js";
import { writeRawJson } from "../migrations/raw-json.js";
import { ENDPOINTS_FILE } from "./endpoints.js";

function endpointsPath(): string {
  return resolve(config.proxyConfigDir, ENDPOINTS_FILE);
}

function readRawEndpoints(): Record<string, unknown>[] | null {
  const path = endpointsPath();
  if (!existsSync(path)) {
    return null;
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null;
}

export function storedEndpointsHaveRemoteInstances(): boolean {
  const records = readRawEndpoints();
  return Boolean(
    records?.some((record) => record["kind"] === "managed-instance"),
  );
}

export function dropStoredRemoteInstanceEndpoints(): void {
  const records = readRawEndpoints();
  if (!records) {
    return;
  }
  const next = records.filter(
    (record) => record["kind"] !== "managed-instance",
  );
  writeRawJson(endpointsPath(), next);
}
