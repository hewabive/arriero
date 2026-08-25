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
import { readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";

import { config } from "../config.js";
import { statSizeOrNull } from "../utils/stat.js";

const requestFilesRoot = resolve(config.dataDir, "proxy-requests");

function requestDirStamp(iso: string) {
  return iso.replace(/[:.]/g, "-");
}

function requestDirName(traceId: string, traceAt: string) {
  return `${requestDirStamp(traceAt)}-${traceId}`;
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
  const cutoffStamp = requestDirStamp(cutoffIso);
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
    } catch {}
  }
  return removed;
}

async function readDirectoryEntriesAsync(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch {
    return [];
  }
}

export async function apiProxyRequestFilesUsage(): Promise<{
  requestDirs: number;
  bytes: number;
}> {
  let requestDirs = 0;
  let bytes = 0;
  for (const modelEntry of await readDirectoryEntriesAsync(requestFilesRoot)) {
    if (!modelEntry.isDirectory()) {
      continue;
    }
    const modelDir = resolve(requestFilesRoot, modelEntry.name);
    for (const requestEntry of await readDirectoryEntriesAsync(modelDir)) {
      if (!requestEntry.isDirectory()) {
        continue;
      }
      requestDirs += 1;
      const requestDir = resolve(modelDir, requestEntry.name);
      const entries = await readDirectoryEntriesAsync(requestDir);
      const sizes = await Promise.all(
        entries
          .filter((entry) => entry.isFile())
          .map((entry) => statSizeOrNull(resolve(requestDir, entry.name))),
      );
      for (const size of sizes) {
        if (size !== null) {
          bytes += size;
        }
      }
    }
  }
  return { requestDirs, bytes };
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
