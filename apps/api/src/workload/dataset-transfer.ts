import {
  WorkloadDatasetManifestSchema,
  type WorkloadDatasetImportResult,
  type WorkloadDatasetManifest,
} from "@arriero/core";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import { StringDecoder } from "node:string_decoder";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { createGunzip, createGzip } from "node:zlib";

import { logger } from "../logger.js";
import { asObject } from "../proxy/json.js";
import {
  workloadBlobHash,
  workloadContentBlobHashes,
  workloadDatasetId,
} from "./dataset-codec.js";
import {
  readWorkloadDatasetBlobJson,
  stageWorkloadDataset,
} from "./dataset-store.js";

const EXPORT_FORMAT = "arriero-workload-dataset";
const MAX_IMPORT_BYTES = 4 * 1024 ** 3;
const MAX_LINE_BYTES = 256 * 1024 ** 2;
const BLOB_HASH_PATTERN = /^[0-9a-f]{64}$/;

export class WorkloadImportError extends Error {}

export function workloadDatasetExportFileName(
  manifest: WorkloadDatasetManifest,
): string {
  const base =
    manifest.meta.name
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "dataset";
  return `${base}-${manifest.id.slice(0, 12)}.workload.jsonl.gz`;
}

async function* exportLines(
  manifest: WorkloadDatasetManifest,
): AsyncGenerator<string> {
  yield `${JSON.stringify({ format: EXPORT_FORMAT, manifest })}\n`;
  for (const hash of workloadContentBlobHashes(manifest.content)) {
    const json = await readWorkloadDatasetBlobJson(manifest.id, hash);
    yield `{"hash":"${hash}","value":${json}}\n`;
  }
}

export function workloadDatasetExportStream(
  manifest: WorkloadDatasetManifest,
): ReadableStream<Uint8Array> {
  const gzip = createGzip();
  pipeline(Readable.from(exportLines(manifest)), gzip).catch(
    (error: unknown) => {
      logger.warn(
        { error, datasetId: manifest.id },
        "workload dataset export stopped",
      );
      gzip.destroy(error instanceof Error ? error : new Error(String(error)));
    },
  );
  return Readable.toWeb(gzip) as ReadableStream<Uint8Array>;
}

class ByteLimit extends Transform {
  private total = 0;

  constructor(private readonly limit: number) {
    super();
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    this.total += chunk.length;
    if (this.total > this.limit) {
      callback(
        new WorkloadImportError(
          `the dataset is larger than ${Math.round(this.limit / 1024 ** 2)} MiB`,
        ),
      );
      return;
    }
    callback(null, chunk);
  }
}

async function* readLines(stream: Readable): AsyncGenerator<string> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  for await (const chunk of stream) {
    pending += decoder.write(chunk as Buffer);
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      yield pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    if (pending.length > MAX_LINE_BYTES) {
      throw new WorkloadImportError("a line of the dataset is too large");
    }
  }
  pending += decoder.end();
  if (pending.length > 0) {
    yield pending;
  }
}

function parseLine(line: string, index: number): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new WorkloadImportError(`line ${index + 1} is not valid JSON`);
  }
}

function parseManifest(value: unknown): WorkloadDatasetManifest {
  const header = asObject(value);
  if (header?.format !== EXPORT_FORMAT) {
    throw new WorkloadImportError(
      "the file is not an arriero workload dataset",
    );
  }
  const parsed = WorkloadDatasetManifestSchema.safeParse(header.manifest);
  if (!parsed.success) {
    throw new WorkloadImportError(
      `the dataset manifest is invalid: ${parsed.error.issues[0]?.message ?? "unknown"}`,
    );
  }
  if (workloadDatasetId(parsed.data.content) !== parsed.data.id) {
    throw new WorkloadImportError("the dataset content does not match its id");
  }
  return parsed.data;
}

export async function importWorkloadDataset(
  body: ReadableStream<Uint8Array>,
): Promise<WorkloadDatasetImportResult> {
  const limited = new ByteLimit(MAX_IMPORT_BYTES);
  const gunzip = createGunzip();
  const decodingFailure = pipeline(
    Readable.fromWeb(body as NodeReadableStream<Uint8Array>),
    gunzip,
    limited,
  ).then(
    () => null,
    (error: unknown) => error,
  );
  const staging = await stageWorkloadDataset();
  try {
    let manifest: WorkloadDatasetManifest | null = null;
    let required = new Set<string>();
    const received = new Set<string>();
    let index = 0;
    for await (const line of readLines(limited)) {
      if (line.trim() === "") {
        index += 1;
        continue;
      }
      const value = parseLine(line, index);
      if (!manifest) {
        manifest = parseManifest(value);
        required = new Set(workloadContentBlobHashes(manifest.content));
        index += 1;
        continue;
      }
      const entry = asObject(value);
      const hash = entry?.hash;
      if (typeof hash !== "string" || !BLOB_HASH_PATTERN.test(hash)) {
        throw new WorkloadImportError(`line ${index + 1} has no valid hash`);
      }
      const json = JSON.stringify(entry?.value) ?? "null";
      if (workloadBlobHash(json) !== hash) {
        throw new WorkloadImportError(
          `line ${index + 1} does not match its hash`,
        );
      }
      if (!required.has(hash)) {
        throw new WorkloadImportError(
          `line ${index + 1} carries a blob the dataset does not use`,
        );
      }
      await staging.writeBlob(hash, json);
      received.add(hash);
      index += 1;
    }
    const failure = await decodingFailure;
    if (failure !== null) {
      throw failure;
    }
    if (!manifest) {
      throw new WorkloadImportError("the file is empty");
    }
    const missing = [...required].filter((hash) => !received.has(hash));
    if (missing.length > 0) {
      throw new WorkloadImportError(
        `the dataset is missing ${missing.length} of ${required.size} blobs`,
      );
    }
    const { created } = await staging.commit(manifest);
    return { id: manifest.id, imported: created };
  } catch (error) {
    limited.destroy();
    const failure = await decodingFailure;
    if (failure !== null && failure !== error) {
      logger.debug({ error: failure }, "workload dataset import stream closed");
    }
    await staging.discard();
    if (error instanceof WorkloadImportError) {
      throw error;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new WorkloadImportError(`the dataset could not be read: ${message}`);
  }
}
