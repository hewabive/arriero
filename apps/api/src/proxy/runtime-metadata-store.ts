import {
  ApiProxyRuntimeMetadataRecordSchema,
  type ApiProxyRuntimeMetadataRecord,
} from "@arriero/core";
import { resolve } from "node:path";
import { z } from "zod";

import { config } from "../config.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { readValidatedJsonFile } from "../utils/json-file.js";

export const RUNTIME_METADATA_FILE = resolve(
  config.dataDir,
  "proxy-runtime-metadata.json",
);

let cache: Map<string, ApiProxyRuntimeMetadataRecord> | null = null;

function nowIso() {
  return new Date().toISOString();
}

function load(): Map<string, ApiProxyRuntimeMetadataRecord> {
  if (cache) {
    return cache;
  }
  const map = new Map<string, ApiProxyRuntimeMetadataRecord>();
  const records = readValidatedJsonFile(
    RUNTIME_METADATA_FILE,
    z.array(ApiProxyRuntimeMetadataRecordSchema),
    "proxy runtime metadata",
  );
  for (const record of records ?? []) {
    map.set(record.targetId, record);
  }
  cache = map;
  return map;
}

function persist(map: Map<string, ApiProxyRuntimeMetadataRecord>) {
  atomicWriteFile(
    RUNTIME_METADATA_FILE,
    `${JSON.stringify([...map.values()], null, 2)}\n`,
  );
  cache = map;
}

export function seedApiProxyRuntimeMetadata(
  records: ApiProxyRuntimeMetadataRecord[],
): void {
  const map = new Map<string, ApiProxyRuntimeMetadataRecord>();
  for (const record of records) {
    map.set(record.targetId, record);
  }
  persist(map);
}

export function listApiProxyRuntimeMetadata(): Map<
  string,
  ApiProxyRuntimeMetadataRecord
> {
  return new Map(load());
}

export function getApiProxyRuntimeMetadata(
  targetId: string,
): ApiProxyRuntimeMetadataRecord | null {
  return load().get(targetId) ?? null;
}

export function setApiProxyRuntimeMetadata(
  targetId: string,
  patch: { savedSlotIds?: number[] },
): ApiProxyRuntimeMetadataRecord {
  const map = load();
  const current = map.get(targetId);
  const record = ApiProxyRuntimeMetadataRecordSchema.parse({
    targetId,
    savedSlotIds: patch.savedSlotIds ?? current?.savedSlotIds ?? [],
    updatedAt: nowIso(),
  });
  map.set(targetId, record);
  persist(map);
  return record;
}

export function apiProxySlotFilename(targetId: string, slotId: number): string {
  const slug = targetId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `arriero-${slug}-slot-${slotId}.bin`;
}

export function addApiProxySavedSlotId(
  targetId: string,
  slotId: number,
): ApiProxyRuntimeMetadataRecord {
  const next = new Set(
    getApiProxyRuntimeMetadata(targetId)?.savedSlotIds ?? [],
  );
  next.add(slotId);
  return setApiProxyRuntimeMetadata(targetId, {
    savedSlotIds: [...next].sort((left, right) => left - right),
  });
}

export function removeApiProxySavedSlotId(
  targetId: string,
  slotId: number,
): ApiProxyRuntimeMetadataRecord {
  const next = new Set(
    getApiProxyRuntimeMetadata(targetId)?.savedSlotIds ?? [],
  );
  next.delete(slotId);
  return setApiProxyRuntimeMetadata(targetId, {
    savedSlotIds: [...next].sort((left, right) => left - right),
  });
}

export function deleteApiProxyRuntimeMetadata(targetId: string): boolean {
  const map = load();
  if (!map.has(targetId)) {
    return false;
  }
  map.delete(targetId);
  persist(map);
  return true;
}

export function resetApiProxyRuntimeMetadataCache(): void {
  cache = null;
}
