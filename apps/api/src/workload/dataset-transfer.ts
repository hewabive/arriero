import {
  WorkloadContentHashSchema,
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
import { errorMessage } from "../utils/error-message.js";
import {
  encodeWorkloadBlob,
  workloadContentBlobHashes,
  workloadDatasetId,
} from "./dataset-codec.js";
import {
  readWorkloadDatasetBlobJson,
  stageWorkloadDataset,
  workloadDatasetExists,
} from "./dataset-store.js";

const EXPORT_FORMAT = "arriero-workload-dataset";
const MAX_IMPORT_BYTES = 4 * 1024 ** 3;
const MAX_LINE_BYTES = 256 * 1024 ** 2;

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
  let fragments: string[] = [];
  let pendingLength = 0;
  for await (const chunk of stream) {
    const text = decoder.write(chunk as Buffer);
    let start = 0;
    let newline = text.indexOf("\n");
    while (newline !== -1) {
      fragments.push(text.slice(start, newline));
      yield fragments.join("");
      fragments = [];
      pendingLength = 0;
      start = newline + 1;
      newline = text.indexOf("\n", start);
    }
    if (start < text.length) {
      fragments.push(text.slice(start));
      pendingLength += text.length - start;
    }
    if (pendingLength > MAX_LINE_BYTES) {
      throw new WorkloadImportError("a line of the dataset is too large");
    }
  }
  fragments.push(decoder.end());
  const last = fragments.join("");
  if (last.length > 0) {
    yield last;
  }
}

function parseLine(line: string, lineNumber: number): unknown {
  try {
    return JSON.parse(line);
  } catch {
    throw new WorkloadImportError(`line ${lineNumber} is not valid JSON`);
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
    let alreadyStored = false;
    let required = new Set<string>();
    const received = new Set<string>();
    let lineNumber = 0;
    for await (const line of readLines(limited)) {
      lineNumber += 1;
      if (line.trim() === "") {
        continue;
      }
      const value = parseLine(line, lineNumber);
      if (!manifest) {
        manifest = parseManifest(value);
        alreadyStored = workloadDatasetExists(manifest.id);
        required = new Set(workloadContentBlobHashes(manifest.content));
        continue;
      }
      const entry = asObject(value);
      const hash = entry?.hash;
      if (
        typeof hash !== "string" ||
        !WorkloadContentHashSchema.safeParse(hash).success
      ) {
        throw new WorkloadImportError(`line ${lineNumber} has no valid hash`);
      }
      const blob = encodeWorkloadBlob(entry?.value);
      if (blob.hash !== hash) {
        throw new WorkloadImportError(
          `line ${lineNumber} does not match its hash`,
        );
      }
      if (!required.has(hash)) {
        throw new WorkloadImportError(
          `line ${lineNumber} carries a blob the dataset does not use`,
        );
      }
      if (!alreadyStored) {
        await staging.writeBlob(hash, blob.json);
      }
      received.add(hash);
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
    if (alreadyStored) {
      await staging.discard();
      return { id: manifest.id, imported: false };
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
    throw new WorkloadImportError(
      `the dataset could not be read: ${errorMessage(error)}`,
    );
  }
}
