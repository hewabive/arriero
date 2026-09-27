import {
  WORKLOAD_DATASET_ID_PATTERN,
  WorkloadDatasetManifestSchema,
  type WorkloadDatasetDetail,
  type WorkloadDatasetManifest,
  type WorkloadDatasetSummary,
  type WorkloadSegmentSummary,
} from "@arriero/core";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

import { config } from "../config.js";
import { parsePersistedJson } from "../db/persisted-json.js";
import { logger } from "../logger.js";
import { newId } from "../utils/id.js";

const datasetsRoot = resolve(config.dataDir, "workload-datasets");
const MANIFEST_FILE = "manifest.json";
const BLOBS_DIR = "blobs";
const STAGING_PREFIX = ".staging-";
const BLOB_HASH_PATTERN = /^[0-9a-f]{64}$/;

function datasetDir(id: string): string | null {
  return WORKLOAD_DATASET_ID_PATTERN.test(id)
    ? resolve(datasetsRoot, id)
    : null;
}

function blobPath(dir: string, hash: string): string {
  if (!BLOB_HASH_PATTERN.test(hash)) {
    throw new Error(`invalid blob hash ${hash}`);
  }
  return join(dir, BLOBS_DIR, `${hash}.json`);
}

export type WorkloadDatasetStaging = {
  writeBlob: (hash: string, json: string) => Promise<void>;
  commit: (manifest: WorkloadDatasetManifest) => Promise<{ created: boolean }>;
  discard: () => Promise<void>;
};

export async function stageWorkloadDataset(): Promise<WorkloadDatasetStaging> {
  const staging = resolve(datasetsRoot, `${STAGING_PREFIX}${newId()}`);
  await mkdir(join(staging, BLOBS_DIR), { recursive: true });
  const written = new Set<string>();
  const discard = () => rm(staging, { recursive: true, force: true });
  return {
    writeBlob: async (hash, json) => {
      if (written.has(hash)) {
        return;
      }
      await writeFile(blobPath(staging, hash), json, "utf8");
      written.add(hash);
    },
    commit: async (manifest) => {
      const target = datasetDir(manifest.id);
      if (!target) {
        await discard();
        throw new Error(`invalid dataset id ${manifest.id}`);
      }
      if (existsSync(join(target, MANIFEST_FILE))) {
        await discard();
        return { created: false };
      }
      await writeFile(
        join(staging, MANIFEST_FILE),
        `${JSON.stringify(manifest)}\n`,
        "utf8",
      );
      await rename(staging, target);
      return { created: true };
    },
    discard,
  };
}

export function sweepWorkloadDatasetStaging(): number {
  if (!existsSync(datasetsRoot)) {
    return 0;
  }
  let removed = 0;
  for (const entry of readdirSync(datasetsRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith(STAGING_PREFIX)) {
      rmSync(resolve(datasetsRoot, entry.name), {
        recursive: true,
        force: true,
      });
      removed += 1;
    }
  }
  return removed;
}

export function readWorkloadDatasetManifest(
  id: string,
): WorkloadDatasetManifest | null {
  const dir = datasetDir(id);
  if (!dir || !existsSync(join(dir, MANIFEST_FILE))) {
    return null;
  }
  const manifest = parsePersistedJson(
    WorkloadDatasetManifestSchema,
    readFileSync(join(dir, MANIFEST_FILE), "utf8"),
  );
  if (!manifest) {
    logger.warn({ datasetId: id }, "workload dataset manifest is unreadable");
  }
  return manifest;
}

export async function readWorkloadDatasetBlobJson(
  id: string,
  hash: string,
): Promise<string> {
  const dir = datasetDir(id);
  if (!dir) {
    throw new Error(`invalid dataset id ${id}`);
  }
  return readFile(blobPath(dir, hash), "utf8");
}

async function directoryBytes(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      total += await directoryBytes(path);
    } else if (entry.isFile()) {
      total += (await stat(path)).size;
    }
  }
  return total;
}

function summarizeWorkloadDataset(
  manifest: WorkloadDatasetManifest,
  bytes: number,
): WorkloadDatasetSummary {
  const { content, meta } = manifest;
  return {
    id: manifest.id,
    name: meta.name,
    description: meta.description,
    createdAt: meta.createdAt,
    windows: content.selection.windows,
    sourceName: content.selection.sourceName,
    modelId: content.selection.modelId,
    segments: content.segments.length,
    records: content.segments.reduce(
      (total, segment) => total + segment.records.length,
      0,
    ),
    primedSegments: content.segments.filter(
      (segment) => segment.priming !== null,
    ).length,
    bytes,
  };
}

export function describeWorkloadDataset(
  manifest: WorkloadDatasetManifest,
  bytes: number,
): WorkloadDatasetDetail {
  const windows = manifest.content.selection.windows;
  const segments: WorkloadSegmentSummary[] = manifest.content.segments.map(
    (segment) => {
      const windowFromMs = Date.parse(windows[segment.windowIndex]?.from ?? "");
      const origin = Number.isFinite(windowFromMs) ? windowFromMs : 0;
      const first = segment.records[0];
      let lastEndMs = origin;
      let maxPromptTokens: number | null = null;
      for (const record of segment.records) {
        lastEndMs = Math.max(
          lastEndMs,
          origin + record.offsetMs + record.durationMs,
        );
        if (record.promptTokens !== null) {
          maxPromptTokens = Math.max(maxPromptTokens ?? 0, record.promptTokens);
        }
      }
      return {
        sessionId: segment.sessionId,
        windowIndex: segment.windowIndex,
        sourceName: segment.sourceName,
        modelId: segment.modelId,
        records: segment.records.length,
        primed: segment.priming !== null,
        firstAt: new Date(origin + (first?.offsetMs ?? 0)).toISOString(),
        lastEndAt: new Date(lastEndMs).toISOString(),
        maxPromptTokens,
      };
    },
  );
  return {
    summary: summarizeWorkloadDataset(manifest, bytes),
    meta: manifest.meta,
    segments,
  };
}

async function datasetIds(): Promise<string[]> {
  if (!existsSync(datasetsRoot)) {
    return [];
  }
  return (await readdir(datasetsRoot, { withFileTypes: true }))
    .filter(
      (entry) =>
        entry.isDirectory() && WORKLOAD_DATASET_ID_PATTERN.test(entry.name),
    )
    .map((entry) => entry.name);
}

export async function workloadDatasetBytes(id: string): Promise<number> {
  const dir = datasetDir(id);
  return dir && existsSync(dir) ? directoryBytes(dir) : 0;
}

export async function listWorkloadDatasets(): Promise<
  WorkloadDatasetSummary[]
> {
  const summaries: WorkloadDatasetSummary[] = [];
  for (const id of await datasetIds()) {
    const manifest = readWorkloadDatasetManifest(id);
    if (manifest) {
      summaries.push(
        summarizeWorkloadDataset(manifest, await workloadDatasetBytes(id)),
      );
    }
  }
  return summaries.sort((left, right) =>
    right.createdAt.localeCompare(left.createdAt),
  );
}

export function deleteWorkloadDataset(id: string): boolean {
  const dir = datasetDir(id);
  if (!dir || !existsSync(dir)) {
    return false;
  }
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export async function workloadDatasetsUsage(): Promise<{
  datasets: number;
  bytes: number;
}> {
  const ids = await datasetIds();
  let bytes = 0;
  for (const id of ids) {
    bytes += await workloadDatasetBytes(id);
  }
  return { datasets: ids.length, bytes };
}
