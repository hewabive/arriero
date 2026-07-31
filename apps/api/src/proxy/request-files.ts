import {
  ApiProxyRequestFileRecordSchema,
  ApiProxyTraceFileSchema,
  type ApiProxyRequestFileRecord,
  type ApiProxyTraceFile,
} from "@arriero/core";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { resolve, sep } from "node:path";

import { config } from "../config.js";

const requestFilesRoot = resolve(config.dataDir, "proxy-requests");

function requestDirName(traceId: string, traceAt: string) {
  return `${traceAt.replace(/[:.]/g, "-")}-${traceId}`;
}

function modelDirName(modelId: string) {
  const cleaned = modelId.replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100);
  if (cleaned === "" || /^\.+$/.test(cleaned)) {
    return "unknown-model";
  }
  return cleaned;
}

function existingJsonFileCount(dir: string) {
  try {
    return readdirSync(dir).filter((file) => file.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export function saveApiProxyRequestFile(input: {
  traceId: string;
  traceAt: string;
  kind: string;
  label: string | null;
  protocol: ApiProxyRequestFileRecord["protocol"];
  endpoint: string;
  routePath: string;
  modelId: string;
  data: unknown;
}): ApiProxyTraceFile {
  const createdAt = new Date().toISOString();
  const modelDir = modelDirName(input.modelId);
  const dirName = requestDirName(input.traceId, input.traceAt);
  const dir = resolve(requestFilesRoot, modelDir, dirName);
  mkdirSync(dir, { recursive: true });
  const seq = existingJsonFileCount(dir) + 1;
  const name = `${String(seq).padStart(2, "0")}-${input.kind}.json`;
  const record = ApiProxyRequestFileRecordSchema.parse({
    traceId: input.traceId,
    kind: input.kind,
    label: input.label,
    protocol: input.protocol,
    endpoint: input.endpoint,
    routePath: input.routePath,
    modelId: input.modelId,
    createdAt,
    data: input.data,
  });
  const content = `${JSON.stringify(record, null, 2)}\n`;
  writeFileSync(resolve(dir, name), content, "utf8");
  return ApiProxyTraceFileSchema.parse({
    name,
    path: `${modelDir}/${dirName}/${name}`,
    kind: input.kind,
    label: input.label,
    bytes: Buffer.byteLength(content, "utf8"),
    createdAt,
  });
}

const requestDirStampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;

function readDirectoryEntries(path: string) {
  try {
    return readdirSync(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function pruneApiProxyRequestFiles(cutoffIso: string): number {
  const cutoffStamp = cutoffIso.replace(/[:.]/g, "-");
  let removed = 0;
  for (const modelEntry of readDirectoryEntries(requestFilesRoot)) {
    if (!modelEntry.isDirectory()) {
      continue;
    }
    const modelDir = resolve(requestFilesRoot, modelEntry.name);
    for (const requestEntry of readDirectoryEntries(modelDir)) {
      if (!requestEntry.isDirectory()) {
        continue;
      }
      const stamp = requestEntry.name.slice(0, cutoffStamp.length);
      if (!requestDirStampPattern.test(stamp) || stamp >= cutoffStamp) {
        continue;
      }
      rmSync(resolve(modelDir, requestEntry.name), {
        recursive: true,
        force: true,
      });
      removed += 1;
    }
    try {
      rmdirSync(modelDir);
    } catch {
      continue;
    }
  }
  return removed;
}

export function readApiProxyRequestFile(
  relativePath: string,
): ApiProxyRequestFileRecord | null {
  const fullPath = resolve(requestFilesRoot, relativePath);
  if (
    !fullPath.startsWith(`${requestFilesRoot}${sep}`) ||
    !fullPath.endsWith(".json")
  ) {
    return null;
  }
  try {
    return ApiProxyRequestFileRecordSchema.parse(
      JSON.parse(readFileSync(fullPath, "utf8")),
    );
  } catch {
    return null;
  }
}
