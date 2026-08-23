import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { instanceIdFromEndpointId } from "@arriero/core";

import { config } from "../config.js";
import { logger } from "../logger.js";
import { ENDPOINTS_FILE } from "./endpoints.js";
import { MODELS_FILE, TARGETS_FILE } from "./repository.js";

function readRawArray(path: string): Record<string, unknown>[] | null {
  if (!existsSync(path)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : null;
  } catch {
    return null;
  }
}

function writeRawJson(path: string, value: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

function modelsPath(): string {
  return resolve(config.proxyConfigDir, MODELS_FILE);
}

export function modelsFileHasReasoningOverrides(): boolean {
  const records = readRawArray(modelsPath());
  return Boolean(records?.some((record) => "reasoning" in record));
}

function resolveModelEndpointId(
  record: Record<string, unknown>,
  targetEndpointById: Map<string, string>,
): { endpointId: string | null; reason: string | null } {
  const routeTo = record["routeTo"];
  if (routeTo && typeof routeTo === "object" && !Array.isArray(routeTo)) {
    const route = routeTo as Record<string, unknown>;
    if (
      route["type"] === "endpoint" &&
      typeof route["endpointId"] === "string"
    ) {
      return { endpointId: route["endpointId"], reason: null };
    }
    if (route["type"] === "target" && typeof route["id"] === "string") {
      const endpointId = targetEndpointById.get(route["id"]) ?? null;
      return endpointId
        ? { endpointId, reason: null }
        : { endpointId: null, reason: "routed target not found" };
    }
    if (route["type"] === "pipeline") {
      return {
        endpointId: null,
        reason: "routes through a pipeline; the upstream is not static",
      };
    }
  }
  if (typeof record["targetId"] === "string") {
    const endpointId = targetEndpointById.get(record["targetId"]) ?? null;
    return endpointId
      ? { endpointId, reason: null }
      : { endpointId: null, reason: "bound target not found" };
  }
  return { endpointId: null, reason: "no static route to an upstream" };
}

function moveToInstance(instanceName: string, reasoning: unknown): boolean {
  const path = resolve(config.instancesDir, `${instanceName}.json`);
  if (!existsSync(path)) {
    return false;
  }
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    record = parsed as Record<string, unknown>;
  } catch {
    return false;
  }
  if (record["reasoning"] !== undefined && record["reasoning"] !== null) {
    return false;
  }
  writeRawJson(path, { ...record, reasoning });
  return true;
}

function moveToEndpoint(endpointId: string, reasoning: unknown): boolean {
  const path = resolve(config.proxyConfigDir, ENDPOINTS_FILE);
  const records = readRawArray(path);
  const stored = records?.find((record) => record["id"] === endpointId);
  if (!records || !stored) {
    return false;
  }
  if (stored["reasoning"] !== undefined && stored["reasoning"] !== null) {
    return false;
  }
  stored["reasoning"] = reasoning;
  writeRawJson(path, records);
  return true;
}

export function migrateModelReasoningToUpstreams(): void {
  const records = readRawArray(modelsPath());
  if (!records) {
    return;
  }
  const targets = readRawArray(resolve(config.proxyConfigDir, TARGETS_FILE));
  const targetEndpointById = new Map<string, string>();
  for (const target of targets ?? []) {
    if (
      typeof target["id"] === "string" &&
      typeof target["endpointId"] === "string"
    ) {
      targetEndpointById.set(target["id"], target["endpointId"]);
    }
  }

  for (const record of records) {
    const reasoning = record["reasoning"];
    if (reasoning === undefined || reasoning === null) {
      continue;
    }
    const modelId = String(record["modelId"] ?? record["id"] ?? "?");
    const resolved = resolveModelEndpointId(record, targetEndpointById);
    if (!resolved.endpointId) {
      logger.warn(
        { modelId, reasoning },
        `proxy model reasoning override dropped: ${resolved.reason ?? "unresolvable route"}; re-create it on the instance or endpoint`,
      );
      continue;
    }
    const instanceName = instanceIdFromEndpointId(resolved.endpointId);
    const moved = instanceName
      ? moveToInstance(instanceName, reasoning)
      : moveToEndpoint(resolved.endpointId, reasoning);
    if (moved) {
      logger.info(
        { modelId, destination: instanceName ?? resolved.endpointId },
        "proxy model reasoning override moved to its upstream",
      );
    } else {
      logger.warn(
        { modelId, endpointId: resolved.endpointId, reasoning },
        "proxy model reasoning override dropped: the upstream is missing or already carries an override",
      );
    }
  }

  writeRawJson(
    modelsPath(),
    records.map(({ reasoning: _drop, ...rest }) => rest),
  );
}
