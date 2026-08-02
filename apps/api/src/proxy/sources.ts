import {
  ApiProxySourceCreateSchema,
  ApiProxySourceRecordSchema,
  ApiProxySourceUpdateSchema,
  type ApiProxySourceCreate,
  type ApiProxySourceRecord,
  type ApiProxySourceUpdate,
} from "@arriero/core";
import { z } from "zod";

import { newId } from "../utils/id.js";
import { sortedByKey } from "../utils/sort.js";
import {
  readCollection,
  readSecret,
  setSecret,
  writeCollection,
} from "./config-files.js";
import type { ApiProxyAuthDiagnostic } from "./protocol.js";
import { getApiProxySettings } from "./settings.js";

export const SOURCES_FILE = "sources.json";

export const StoredSourceSchema = ApiProxySourceRecordSchema.pick({
  id: true,
  name: true,
  enabled: true,
  note: true,
  blockedMessage: true,
});

type StoredSource = z.infer<typeof StoredSourceSchema>;

function sourceSecretId(id: string) {
  return `source:${id}`;
}

function readStoredSources(): StoredSource[] {
  return readCollection(SOURCES_FILE, StoredSourceSchema);
}

function persistSources(records: StoredSource[]) {
  writeCollection(
    SOURCES_FILE,
    sortedByKey(records, (item) => item.name),
  );
}

export function rewriteStoredSources(): void {
  persistSources(readStoredSources());
}

function assertUniqueName(
  records: StoredSource[],
  name: string,
  exceptId: string | null,
) {
  if (records.some((item) => item.name === name && item.id !== exceptId)) {
    throw new Error(`proxy source name already exists: ${name}`);
  }
}

function toRecord(stored: StoredSource): ApiProxySourceRecord {
  return ApiProxySourceRecordSchema.parse({
    id: stored.id,
    name: stored.name,
    enabled: stored.enabled,
    note: stored.note,
    blockedMessage: stored.blockedMessage,
    keyConfigured: Boolean(readSecret(sourceSecretId(stored.id))),
  });
}

export function listApiProxySources(): ApiProxySourceRecord[] {
  return readStoredSources()
    .map(toRecord)
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getApiProxySource(id: string): ApiProxySourceRecord | null {
  const stored = readStoredSources().find((item) => item.id === id);
  return stored ? toRecord(stored) : null;
}

export function createApiProxySource(
  input: ApiProxySourceCreate,
): ApiProxySourceRecord {
  const parsed = ApiProxySourceCreateSchema.parse(input);
  const records = readStoredSources();
  assertUniqueName(records, parsed.name, null);
  const id = newId();
  const stored = StoredSourceSchema.parse({
    id,
    name: parsed.name,
    enabled: parsed.enabled,
    note: parsed.note,
    blockedMessage: parsed.blockedMessage,
  });
  persistSources([...records, stored]);
  if (parsed.apiKey) {
    assertUniqueKey(records, parsed.apiKey, null);
    setSecret(sourceSecretId(id), parsed.apiKey);
  }
  const created = getApiProxySource(id);
  if (!created) {
    throw new Error("failed to create proxy source");
  }
  return created;
}

export function updateApiProxySource(
  id: string,
  input: ApiProxySourceUpdate,
): ApiProxySourceRecord | null {
  const records = readStoredSources();
  const current = records.find((item) => item.id === id);
  if (!current) {
    return null;
  }
  const parsed = ApiProxySourceUpdateSchema.parse(input);
  const next = StoredSourceSchema.parse({
    id: current.id,
    name: parsed.name ?? current.name,
    enabled: parsed.enabled ?? current.enabled,
    note: parsed.note ?? current.note,
    blockedMessage: parsed.blockedMessage ?? current.blockedMessage,
  });
  assertUniqueName(records, next.name, id);
  if (parsed.apiKey !== undefined && parsed.apiKey) {
    assertUniqueKey(records, parsed.apiKey, id);
  }
  persistSources(records.map((item) => (item.id === id ? next : item)));
  if (parsed.apiKey !== undefined) {
    setSecret(sourceSecretId(id), parsed.apiKey || null);
  }
  return getApiProxySource(id);
}

export function deleteApiProxySource(id: string): boolean {
  const records = readStoredSources();
  if (!records.some((item) => item.id === id)) {
    return false;
  }
  persistSources(records.filter((item) => item.id !== id));
  setSecret(sourceSecretId(id), null);
  return true;
}

function assertUniqueKey(
  records: StoredSource[],
  key: string,
  exceptId: string | null,
) {
  const owner = records.find(
    (item) =>
      item.id !== exceptId && readSecret(sourceSecretId(item.id)) === key,
  );
  if (owner) {
    throw new Error(`API key already assigned to source: ${owner.name}`);
  }
}

export function getApiProxySourceKey(id: string): string | null {
  return readSecret(sourceSecretId(id));
}

export function extractRequestApiKey(headers: Headers): string | null {
  const apiKeyHeader = headers.get("x-api-key");
  if (apiKeyHeader && apiKeyHeader.trim()) {
    return apiKeyHeader.trim();
  }
  const authorization = headers.get("authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return null;
}

export type RequestSourceResolution =
  | { kind: "anonymous" }
  | { kind: "unknown" }
  | {
      kind: "source";
      id: string;
      name: string;
      enabled: boolean;
      blockedMessage: string;
    };

export function resolveApiProxyRequestSource(
  key: string | null,
): RequestSourceResolution {
  if (!key) {
    return { kind: "anonymous" };
  }
  for (const stored of readStoredSources()) {
    if (readSecret(sourceSecretId(stored.id)) === key) {
      return {
        kind: "source",
        id: stored.id,
        name: stored.name,
        enabled: stored.enabled,
        blockedMessage: stored.blockedMessage,
      };
    }
  }
  return { kind: "unknown" };
}

export function apiProxyRequestSourceRejection(
  resolution: RequestSourceResolution,
  allowAnonymous: boolean,
): ApiProxyAuthDiagnostic | null {
  if (resolution.kind === "source") {
    if (resolution.enabled) {
      return null;
    }
    return {
      status: 403,
      code: "arriero_proxy_source_disabled",
      message:
        resolution.blockedMessage ||
        `Source ${resolution.name} is disabled by the administrator.`,
    };
  }
  if (allowAnonymous) {
    return null;
  }
  return resolution.kind === "anonymous"
    ? {
        status: 401,
        code: "arriero_proxy_source_required",
        message:
          "Anonymous requests are disabled. Provide a source API key via Authorization: Bearer or x-api-key.",
      }
    : {
        status: 401,
        code: "invalid_api_key",
        message: "Unknown API key. Requests must use a configured source key.",
      };
}

export function apiProxyRequestGate(headers: Headers): {
  resolution: RequestSourceResolution;
  rejection: ApiProxyAuthDiagnostic | null;
} {
  const resolution = resolveApiProxyRequestSource(
    extractRequestApiKey(headers),
  );
  return {
    resolution,
    rejection: apiProxyRequestSourceRejection(
      resolution,
      getApiProxySettings().allowAnonymous,
    ),
  };
}
