import { hfManifestOidMatches } from "@arriero/core";
import { createHash, type Hash } from "node:crypto";
import { once } from "node:events";
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
} from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import { logger } from "../logger.js";
import { errorMessage } from "../utils/error-message.js";
import {
  hfErrorFromResponse,
  hfRequestHeaders,
  hfResolveUrl,
  HfHubError,
  type HfClientOptions,
} from "./client.js";
import {
  chunkCountFor,
  chunkSizeAt,
  readHfChunkSidecar,
  removeHfChunkSidecar,
  writeHfChunkSidecar,
} from "./chunk-store.js";
import type { HfPlannedFile } from "./download-plan.js";
import {
  fetchDownloadImpl,
  hfDownloadRequest,
  type HfDownloadImpl,
  type HfDownloadResponse,
} from "./http.js";
import type { HfManifestFile } from "./manifest.js";
import {
  hfChunkBytes,
  HfConnectionTuner,
  hfInitialConnections,
  hfMaxConnections,
  type HfTransferTuningOverrides,
} from "./transfer-tuning.js";

const CHUNK_ATTEMPT_LIMIT = 5;
const RATE_LIMIT_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 240_000];
const RATE_LIMIT_MAX_DELAY_MS = 300_000;
const RATE_LIMIT_BUDGET_MS = 600_000;
const WRITE_BATCH_BYTES = 1024 * 1024;

type HfTransferEvents = {
  onFileStart: (path: string) => void;
  onFileBytes: (path: string, bytes: number) => void;
  onWireBytes: (deltaBytes: number) => void;
  onTransportError: () => void;
  onConnectionsChange?: ((connections: number) => void) | undefined;
  onFileFinished: (
    file: HfPlannedFile,
    outcome: "succeeded" | "skipped",
  ) => void;
  onFileFailed: (path: string, message: string) => void;
  onFileCanceled: (path: string) => void;
};

export type HfTransferContext = {
  repoId: string;
  sha: string;
  planned: HfPlannedFile[];
  signal: AbortSignal;
  clientOptions: HfClientOptions;
  manifestEntries: Map<string, HfManifestFile>;
  tuning?: HfTransferTuningOverrides | undefined;
  isFileCanceled: (path: string) => boolean;
  fileAborts: Map<string, () => void>;
  events: HfTransferEvents;
  sleep?: ((ms: number) => Promise<void>) | undefined;
};

export type HfTransferResult = {
  failedCount: number;
  fatalError: string | null;
  stalled: string | null;
};

class RangeUnsupportedError extends Error {}

function createContentHash(file: HfPlannedFile): Hash {
  if (file.lfs) {
    return createHash("sha256");
  }
  const hash = createHash("sha1");
  hash.update(`blob ${file.size}\0`);
  return hash;
}

function expectedHex(file: HfPlannedFile): string {
  return file.lfs ? file.lfs.oid : file.oid;
}

async function feedFileToHash(path: string, hash: Hash): Promise<void> {
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
  }
}

async function hashLocalFile(
  file: HfPlannedFile,
  path: string,
): Promise<string> {
  const hash = createContentHash(file);
  await feedFileToHash(path, hash);
  return hash.digest("hex");
}

function manifestEntryMatches(
  entry: HfManifestFile | null,
  file: HfPlannedFile,
): boolean {
  return (
    entry !== null &&
    entry.size === file.size &&
    hfManifestOidMatches(entry, file)
  );
}

function isTransientError(error: unknown): boolean {
  return (
    error instanceof HfHubError &&
    (error.kind === "network" || error.kind === "upstream")
  );
}

function isFatalAuthError(error: unknown): boolean {
  return (
    error instanceof HfHubError &&
    (error.kind === "unauthorized" || error.kind === "gated")
  );
}

function isEnospc(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOSPC";
}

function streamErrorMessage(error: unknown): string {
  const message = errorMessage(error);
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error ? `${message}: ${cause.message}` : message;
}

function asTransportError(error: unknown, path: string): unknown {
  if (error instanceof HfHubError || isEnospc(error)) {
    return error;
  }
  return new HfHubError(
    "network",
    null,
    `download stream interrupted for ${path}: ${streamErrorMessage(error)}`,
  );
}

function backoffMs(attempt: number): number {
  return (
    Math.min(30_000, 1_000 * 2 ** attempt) + Math.floor(Math.random() * 500)
  );
}

type DownloadFileContext = {
  url: string;
  file: HfPlannedFile;
  signal: AbortSignal;
  clientOptions: HfClientOptions;
  downloadImpl: HfDownloadImpl;
  beforeRequest: () => Promise<number>;
  onRequestSuccess: (generation: number) => void;
  onBytes: (bytes: number) => void;
  onWireBytes: (deltaBytes: number) => void;
};

async function attemptDownload(
  ctx: DownloadFileContext,
  fromScratch: boolean,
): Promise<"downloaded" | "range-not-satisfiable"> {
  const { file, signal, clientOptions } = ctx;
  let offset = 0;
  if (existsSync(file.partPath)) {
    const partSize = statSync(file.partPath).size;
    if (!fromScratch && partSize > 0 && partSize < file.size) {
      offset = partSize;
    } else if (partSize !== 0) {
      truncateSync(file.partPath, 0);
    }
  }
  const headers: Record<string, string> = {
    ...hfRequestHeaders(clientOptions),
  };
  if (offset > 0) {
    headers.range = `bytes=${offset}-`;
  }
  const requestGeneration = await ctx.beforeRequest();
  let response: HfDownloadResponse;
  try {
    response = await ctx.downloadImpl(ctx.url, {
      headers,
      signal,
    });
  } catch (error) {
    if (signal.aborted) {
      throw error;
    }
    throw new HfHubError(
      "network",
      null,
      `download failed: ${(error as Error).message}`,
    );
  }
  if (response.status === 416) {
    await response.discard();
    if (existsSync(file.partPath)) {
      truncateSync(file.partPath, 0);
    }
    return "range-not-satisfiable";
  }
  if (!response.ok) {
    throw await hfErrorFromResponse(response);
  }
  if (offset > 0 && response.status !== 206) {
    truncateSync(file.partPath, 0);
    offset = 0;
  }
  if (!response.body) {
    throw new HfHubError(
      "upstream",
      response.status,
      `empty response body for ${file.path}`,
    );
  }
  const hash = createContentHash(file);
  if (offset > 0) {
    await feedFileToHash(file.partPath, hash);
  }
  let received = offset;
  ctx.onBytes(received);
  const out = createWriteStream(file.partPath, {
    flags: offset > 0 ? "a" : "w",
  });
  let writeError: Error | null = null;
  out.on("error", (error: Error) => {
    writeError = error;
  });
  const body = response.body as unknown as AsyncIterable<Uint8Array>;
  try {
    for await (const chunk of body) {
      if (writeError !== null) {
        throw writeError;
      }
      hash.update(chunk);
      received += chunk.length;
      ctx.onWireBytes(chunk.length);
      ctx.onBytes(received);
      if (!out.write(chunk)) {
        await once(out, "drain");
      }
    }
    if (writeError !== null) {
      throw writeError;
    }
    await new Promise<void>((resolveDone, reject) => {
      out.end(() => {
        if (writeError !== null) {
          reject(writeError);
        } else {
          resolveDone();
        }
      });
    });
  } catch (error) {
    await new Promise<void>((resolveDone) => {
      out.end(() => resolveDone());
    });
    if (signal.aborted || writeError !== null) {
      throw error;
    }
    throw asTransportError(error, file.path);
  }
  if (received !== file.size) {
    throw new HfHubError(
      "network",
      null,
      `incomplete download of ${file.path}: got ${received} of ${file.size} bytes`,
    );
  }
  ctx.onRequestSuccess(requestGeneration);
  const hex = hash.digest("hex");
  if (hex !== expectedHex(file)) {
    rmSync(file.partPath, { force: true });
    throw new Error(
      `checksum mismatch for ${file.path}: expected ${expectedHex(file)}, got ${hex}`,
    );
  }
  renameSync(file.partPath, file.finalPath);
  return "downloaded";
}

async function downloadOneFile(
  ctx: DownloadFileContext,
): Promise<"succeeded" | "skipped"> {
  const first = await attemptDownload(ctx, false);
  if (first === "downloaded") {
    return "succeeded";
  }
  const second = await attemptDownload(ctx, true);
  if (second === "downloaded") {
    return "succeeded";
  }
  throw new Error(
    `could not download ${ctx.file.path}: server rejected the range request twice`,
  );
}

type ChunkedFile = {
  file: HfPlannedFile;
  handle: FileHandle;
  chunkBytes: number;
  chunkCount: number;
  completed: Set<number>;
  claimed: Set<number>;
  liveByChunk: Map<number, number>;
  bytesDone: number;
  controllers: Set<AbortController>;
  url: string | null;
  nextChunkIndex: number;
  canceled: boolean;
  closed: boolean;
  settled: boolean;
};

type ChunkProgress = { flushed: number };

type Work =
  | { kind: "chunk"; state: ChunkedFile; index: number }
  | { kind: "single"; file: HfPlannedFile }
  | "open"
  | "wait"
  | "done";

export async function runHfTransfer(
  ctx: HfTransferContext,
): Promise<HfTransferResult> {
  const sleep =
    ctx.sleep ??
    ((ms: number) =>
      new Promise<void>((resolveDone) => {
        if (ctx.signal.aborted) {
          resolveDone();
          return;
        }
        const timer = setTimeout(finish, ms);
        const onAbort = () => finish();
        function finish() {
          clearTimeout(timer);
          ctx.signal.removeEventListener("abort", onAbort);
          resolveDone();
        }
        ctx.signal.addEventListener("abort", onAbort, { once: true });
        if (ctx.signal.aborted) {
          finish();
        }
      }));
  const downloadImpl =
    ctx.clientOptions.downloadImpl ??
    (ctx.clientOptions.fetchImpl
      ? fetchDownloadImpl(ctx.clientOptions.fetchImpl)
      : hfDownloadRequest);
  const maxConnections = hfMaxConnections(ctx.tuning);
  const initialConnections = hfInitialConnections(ctx.tuning);
  const engine = {
    failedCount: 0,
    fatalError: null as string | null,
    stalled: null as string | null,
    done: false,
    progressStamp: 0,
    nextFileIndex: 0,
    opening: false,
    busy: 0,
    targetConnections: initialConnections,
    openFiles: [] as ChunkedFile[],
    singleQueue: [] as HfPlannedFile[],
    singleControllers: new Set<AbortController>(),
    wakeWaiters: [] as (() => void)[],
  };

  function wake(): void {
    const waiters = engine.wakeWaiters;
    engine.wakeWaiters = [];
    for (const resolveWaiter of waiters) {
      resolveWaiter();
    }
  }

  function waitForWake(): Promise<void> {
    return new Promise((resolveWaiter) => {
      engine.wakeWaiters.push(resolveWaiter);
    });
  }

  const tuner = new HfConnectionTuner({
    initialConnections,
    maxConnections,
    now: ctx.tuning?.now ?? Date.now,
    onChange: (connections) => {
      engine.targetConnections = connections;
      ctx.events.onConnectionsChange?.(connections);
      wake();
    },
  });
  ctx.events.onConnectionsChange?.(initialConnections);

  let rateLimitAttempts = 0;
  let rateLimitGeneration = 0;
  let rateLimitScheduledMs = 0;
  let rateLimitPause: Promise<boolean> | null = null;
  let rateLimitExhausted = false;

  async function beforeRequest(): Promise<number> {
    if (rateLimitPause) {
      await rateLimitPause;
    }
    if (ctx.signal.aborted) {
      throw ctx.signal.reason ?? new Error("download aborted");
    }
    return rateLimitGeneration;
  }

  async function backoffRateLimit(error: HfHubError): Promise<boolean> {
    if (rateLimitExhausted) {
      return false;
    }
    if (rateLimitPause) {
      return rateLimitPause;
    }
    const fallback = RATE_LIMIT_DELAYS_MS[rateLimitAttempts];
    if (fallback === undefined) {
      rateLimitExhausted = true;
      return false;
    }
    const delay = Math.max(
      1_000,
      Math.min(RATE_LIMIT_MAX_DELAY_MS, error.retryAfterMs ?? fallback),
    );
    if (rateLimitScheduledMs + delay > RATE_LIMIT_BUDGET_MS) {
      rateLimitExhausted = true;
      return false;
    }
    rateLimitAttempts += 1;
    rateLimitGeneration += 1;
    rateLimitScheduledMs += delay;
    tuner.recordRateLimit();
    const pause = (async () => {
      await sleep(delay);
      return !ctx.signal.aborted;
    })();
    rateLimitPause = pause;
    try {
      return await pause;
    } finally {
      if (rateLimitPause === pause) {
        rateLimitPause = null;
      }
    }
  }

  function recordRequestSuccess(generation: number): void {
    if (rateLimitPause === null && generation === rateLimitGeneration) {
      rateLimitAttempts = 0;
      rateLimitScheduledMs = 0;
      rateLimitExhausted = false;
    }
  }

  function recordWireBytes(bytes: number): void {
    tuner.recordBytes(bytes);
    ctx.events.onWireBytes(bytes);
  }

  function recordTransportError(): void {
    tuner.recordTransportError();
    ctx.events.onTransportError();
  }

  ctx.signal.addEventListener("abort", wake, { once: true });

  function abortActiveTransfers(): void {
    for (const abort of [...ctx.fileAborts.values()]) {
      abort();
    }
    wake();
  }

  function declareStall(message: string): void {
    if (engine.stalled !== null || engine.fatalError !== null) {
      return;
    }
    engine.stalled = message;
    logger.warn(
      { repoId: ctx.repoId, message },
      "hf transfer stalled without progress; pausing",
    );
    for (const state of engine.openFiles) {
      for (const controller of [...state.controllers]) {
        controller.abort();
      }
    }
    for (const controller of [...engine.singleControllers]) {
      controller.abort();
    }
    wake();
  }

  function reportBytes(state: ChunkedFile): void {
    let live = 0;
    for (const bytes of state.liveByChunk.values()) {
      live += bytes;
    }
    ctx.events.onFileBytes(
      state.file.path,
      Math.min(state.file.size, state.bytesDone + live),
    );
  }

  async function closeState(state: ChunkedFile): Promise<void> {
    if (state.closed) {
      return;
    }
    state.closed = true;
    try {
      await state.handle.close();
    } catch (error) {
      logger.warn(
        { path: state.file.path, err: error },
        "failed to close hf part file handle",
      );
    }
  }

  function detachState(state: ChunkedFile): void {
    engine.openFiles = engine.openFiles.filter((entry) => entry !== state);
    ctx.fileAborts.delete(state.file.path);
  }

  async function settleCanceled(state: ChunkedFile): Promise<void> {
    if (state.settled) {
      return;
    }
    state.settled = true;
    detachState(state);
    await closeState(state);
    ctx.events.onFileCanceled(state.file.path);
    wake();
  }

  async function settleFailed(
    state: ChunkedFile,
    message: string,
    options?: { removePart?: boolean },
  ): Promise<void> {
    if (state.settled) {
      return;
    }
    state.settled = true;
    detachState(state);
    for (const controller of state.controllers) {
      controller.abort();
    }
    await closeState(state);
    if (options?.removePart) {
      rmSync(state.file.partPath, { force: true });
      removeHfChunkSidecar(state.file.finalPath);
    }
    engine.failedCount += 1;
    ctx.events.onFileFailed(state.file.path, message);
    logger.warn(
      { repoId: ctx.repoId, path: state.file.path, message },
      "hf file download failed",
    );
    wake();
  }

  async function switchToSingleStream(state: ChunkedFile): Promise<void> {
    if (state.settled) {
      return;
    }
    state.settled = true;
    detachState(state);
    for (const controller of state.controllers) {
      controller.abort();
    }
    await closeState(state);
    truncateSync(state.file.partPath, 0);
    removeHfChunkSidecar(state.file.finalPath);
    engine.singleQueue.push(state.file);
    wake();
  }

  async function finalizeChunkedFile(state: ChunkedFile): Promise<void> {
    if (state.settled) {
      return;
    }
    state.settled = true;
    detachState(state);
    await closeState(state);
    const hex = await hashLocalFile(state.file, state.file.partPath);
    if (hex !== expectedHex(state.file)) {
      rmSync(state.file.partPath, { force: true });
      removeHfChunkSidecar(state.file.finalPath);
      engine.failedCount += 1;
      ctx.events.onFileFailed(
        state.file.path,
        `checksum mismatch for ${state.file.path}: expected ${expectedHex(state.file)}, got ${hex}`,
      );
      wake();
      return;
    }
    renameSync(state.file.partPath, state.file.finalPath);
    removeHfChunkSidecar(state.file.finalPath);
    ctx.events.onFileFinished(state.file, "succeeded");
    wake();
  }

  function persistSidecar(state: ChunkedFile): void {
    writeHfChunkSidecar(state.file.finalPath, {
      version: 1,
      size: state.file.size,
      chunkBytes: state.chunkBytes,
      oid: expectedHex(state.file),
      lfs: state.file.lfs !== null,
      revision: ctx.sha,
      completed: [...state.completed],
    });
  }

  async function prepareChunkedFile(file: HfPlannedFile): Promise<ChunkedFile> {
    const expected = expectedHex(file);
    let chunkBytes = hfChunkBytes(file.size, ctx.tuning);
    let completed = new Set<number>();
    const partExists = existsSync(file.partPath);
    const partSize = partExists ? statSync(file.partPath).size : -1;
    const sidecar = readHfChunkSidecar(file.finalPath);
    if (
      sidecar &&
      sidecar.size === file.size &&
      sidecar.oid === expected &&
      sidecar.revision === ctx.sha &&
      partSize === file.size
    ) {
      chunkBytes = sidecar.chunkBytes;
      const count = chunkCountFor(file.size, chunkBytes);
      completed = new Set(sidecar.completed.filter((index) => index < count));
    } else {
      if (sidecar) {
        removeHfChunkSidecar(file.finalPath);
      }
      if (partExists && partSize > 0 && partSize < file.size) {
        const wholeChunks = Math.floor(partSize / chunkBytes);
        completed = new Set(
          Array.from({ length: wholeChunks }, (_, index) => index),
        );
      }
    }
    const handle = await open(file.partPath, partExists ? "r+" : "w+");
    await handle.truncate(file.size);
    const state: ChunkedFile = {
      file,
      handle,
      chunkBytes,
      chunkCount: chunkCountFor(file.size, chunkBytes),
      completed,
      claimed: new Set(completed),
      liveByChunk: new Map(),
      bytesDone: [...completed].reduce(
        (sum, index) => sum + chunkSizeAt(file.size, chunkBytes, index),
        0,
      ),
      controllers: new Set(),
      url: null,
      nextChunkIndex: 0,
      canceled: false,
      closed: false,
      settled: false,
    };
    persistSidecar(state);
    return state;
  }

  async function fetchChunk(
    state: ChunkedFile,
    index: number,
    signal: AbortSignal,
    progress: ChunkProgress,
  ): Promise<void> {
    const size = chunkSizeAt(state.file.size, state.chunkBytes, index);
    const start = index * state.chunkBytes;
    const url = state.url ?? hfResolveUrl(ctx.repoId, ctx.sha, state.file.path);
    const headers: Record<string, string> = {
      ...hfRequestHeaders(ctx.clientOptions),
      range: `bytes=${start + progress.flushed}-${start + size - 1}`,
    };
    const requestGeneration = await beforeRequest();
    let response: HfDownloadResponse;
    try {
      response = await downloadImpl(url, { headers, signal });
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw new HfHubError(
        "network",
        null,
        `download failed: ${(error as Error).message}`,
      );
    }
    if (response.status === 416) {
      await response.discard();
      throw new RangeUnsupportedError();
    }
    if (!response.ok) {
      throw await hfErrorFromResponse(response);
    }
    if (response.status !== 206) {
      await response.discard();
      throw new RangeUnsupportedError();
    }
    if (!response.body) {
      throw new HfHubError(
        "upstream",
        response.status,
        `empty response body for ${state.file.path}`,
      );
    }
    if (state.url === null && response.url) {
      state.url = response.url;
    }
    let received = progress.flushed;
    let position = start + progress.flushed;
    let bufferedBytes = 0;
    let buffered: Uint8Array[] = [];
    const flushBuffered = async () => {
      if (bufferedBytes === 0) {
        return;
      }
      const batch = Buffer.concat(buffered, bufferedBytes);
      let offset = 0;
      while (offset < batch.length) {
        const result = await state.handle.write(
          batch,
          offset,
          batch.length - offset,
          position + offset,
        );
        if (result.bytesWritten <= 0) {
          throw new Error(
            `could not write download chunk for ${state.file.path}`,
          );
        }
        offset += result.bytesWritten;
      }
      position += batch.length;
      progress.flushed += batch.length;
      engine.progressStamp += 1;
      state.liveByChunk.set(index, progress.flushed);
      reportBytes(state);
      buffered = [];
      bufferedBytes = 0;
    };
    try {
      for await (const chunk of response.body) {
        received += chunk.length;
        if (received > size) {
          throw new HfHubError(
            "upstream",
            response.status,
            `server sent more bytes than requested for ${state.file.path}`,
          );
        }
        if (chunk.length > 0) {
          buffered.push(chunk);
          bufferedBytes += chunk.length;
          recordWireBytes(chunk.length);
          if (bufferedBytes >= WRITE_BATCH_BYTES) {
            await flushBuffered();
          }
        }
      }
      await flushBuffered();
    } catch (error) {
      let failure = error;
      try {
        await flushBuffered();
      } catch (writeError) {
        failure = writeError;
      }
      if (signal.aborted) {
        throw failure;
      }
      throw asTransportError(failure, state.file.path);
    }
    if (received !== size) {
      throw new HfHubError(
        "network",
        null,
        `incomplete chunk of ${state.file.path}: got ${received} of ${size} bytes`,
      );
    }
    recordRequestSuccess(requestGeneration);
  }

  async function runChunk(state: ChunkedFile, index: number): Promise<void> {
    let attempt = 0;
    let reResolved = false;
    let noProgressStamp: number | null = null;
    const progress: ChunkProgress = { flushed: 0 };
    for (;;) {
      if (
        ctx.signal.aborted ||
        engine.fatalError !== null ||
        engine.stalled !== null ||
        state.canceled ||
        state.settled
      ) {
        if (state.canceled) {
          await settleCanceled(state);
        }
        return;
      }
      const flushedBefore = progress.flushed;
      const stampBefore = engine.progressStamp;
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      state.controllers.add(controller);
      try {
        await fetchChunk(state, index, controller.signal, progress);
        state.completed.add(index);
        state.liveByChunk.delete(index);
        state.bytesDone += chunkSizeAt(
          state.file.size,
          state.chunkBytes,
          index,
        );
        persistSidecar(state);
        reportBytes(state);
        if (state.completed.size === state.chunkCount) {
          await finalizeChunkedFile(state);
        }
        return;
      } catch (error) {
        if (progress.flushed > 0) {
          state.liveByChunk.set(index, progress.flushed);
        } else {
          state.liveByChunk.delete(index);
        }
        if (ctx.signal.aborted || engine.stalled !== null || state.settled) {
          return;
        }
        if (state.canceled) {
          await settleCanceled(state);
          return;
        }
        if (error instanceof RangeUnsupportedError) {
          await switchToSingleStream(state);
          return;
        }
        if (isFatalAuthError(error)) {
          if (state.url !== null && !reResolved) {
            reResolved = true;
            state.url = null;
            continue;
          }
          engine.fatalError = (error as Error).message;
          await settleFailed(state, (error as Error).message);
          abortActiveTransfers();
          return;
        }
        if (error instanceof HfHubError && error.kind === "rate-limited") {
          if (await backoffRateLimit(error)) {
            continue;
          }
          if (ctx.signal.aborted) {
            return;
          }
          declareStall(error.message);
          return;
        }
        if (isEnospc(error)) {
          engine.fatalError = (error as Error).message;
          await settleFailed(state, (error as Error).message);
          abortActiveTransfers();
          return;
        }
        if (isTransientError(error)) {
          recordTransportError();
          if (progress.flushed > flushedBefore) {
            attempt = 1;
            noProgressStamp = null;
          } else {
            noProgressStamp = noProgressStamp ?? stampBefore;
            attempt += 1;
          }
          if (attempt < CHUNK_ATTEMPT_LIMIT) {
            await sleep(backoffMs(attempt));
            continue;
          }
          if (
            noProgressStamp !== null &&
            engine.progressStamp === noProgressStamp
          ) {
            declareStall((error as Error).message);
            return;
          }
        }
        await settleFailed(state, (error as Error).message);
        return;
      } finally {
        ctx.signal.removeEventListener("abort", onAbort);
        state.controllers.delete(controller);
      }
    }
  }

  async function runSingleFile(file: HfPlannedFile): Promise<void> {
    if (ctx.isFileCanceled(file.path)) {
      ctx.events.onFileCanceled(file.path);
      return;
    }
    ctx.events.onFileStart(file.path);
    const fileController = new AbortController();
    engine.singleControllers.add(fileController);
    const onJobAbort = () => fileController.abort();
    ctx.signal.addEventListener("abort", onJobAbort, { once: true });
    ctx.fileAborts.set(file.path, () => fileController.abort());
    let attempt = 0;
    let reportedBytes = 0;
    let noProgressStamp: number | null = null;
    try {
      for (;;) {
        const bytesBefore = reportedBytes;
        const stampBefore = engine.progressStamp;
        try {
          const outcome = await downloadOneFile({
            url: hfResolveUrl(ctx.repoId, ctx.sha, file.path),
            file,
            signal: fileController.signal,
            clientOptions: ctx.clientOptions,
            downloadImpl,
            beforeRequest,
            onRequestSuccess: recordRequestSuccess,
            onBytes: (bytes) => {
              const capped = Math.min(bytes, file.size);
              if (capped > reportedBytes) {
                reportedBytes = capped;
                engine.progressStamp += 1;
              }
              ctx.events.onFileBytes(file.path, capped);
            },
            onWireBytes: recordWireBytes,
          });
          ctx.events.onFileFinished(file, outcome);
          return;
        } catch (error) {
          if (ctx.signal.aborted || engine.stalled !== null) {
            return;
          }
          if (fileController.signal.aborted) {
            ctx.events.onFileCanceled(file.path);
            return;
          }
          if (error instanceof HfHubError && error.kind === "rate-limited") {
            if (await backoffRateLimit(error)) {
              continue;
            }
            if (ctx.signal.aborted) {
              return;
            }
            declareStall(error.message);
            return;
          }
          if (isTransientError(error)) {
            recordTransportError();
            if (reportedBytes > bytesBefore) {
              attempt = 1;
              noProgressStamp = null;
            } else {
              noProgressStamp = noProgressStamp ?? stampBefore;
              attempt += 1;
            }
            if (attempt < CHUNK_ATTEMPT_LIMIT) {
              await sleep(backoffMs(attempt));
              continue;
            }
            if (
              noProgressStamp !== null &&
              engine.progressStamp === noProgressStamp
            ) {
              declareStall((error as Error).message);
              return;
            }
          }
          const message = (error as Error).message;
          if (isFatalAuthError(error) || isEnospc(error)) {
            engine.fatalError = message;
            ctx.fileAborts.delete(file.path);
            abortActiveTransfers();
          } else {
            engine.failedCount += 1;
          }
          ctx.events.onFileFailed(file.path, message);
          logger.warn(
            { repoId: ctx.repoId, path: file.path, err: error },
            "hf file download failed",
          );
          return;
        }
      }
    } finally {
      engine.singleControllers.delete(fileController);
      ctx.signal.removeEventListener("abort", onJobAbort);
      ctx.fileAborts.delete(file.path);
    }
  }

  async function openNextFile(): Promise<void> {
    const file = ctx.planned[engine.nextFileIndex];
    engine.nextFileIndex += 1;
    if (!file) {
      return;
    }
    if (ctx.isFileCanceled(file.path)) {
      ctx.events.onFileCanceled(file.path);
      return;
    }
    try {
      if (
        existsSync(file.finalPath) &&
        statSync(file.finalPath).size === file.size
      ) {
        if (
          manifestEntryMatches(ctx.manifestEntries.get(file.path) ?? null, file)
        ) {
          ctx.events.onFileFinished(file, "skipped");
          return;
        }
        const hex = await hashLocalFile(file, file.finalPath);
        if (hex === expectedHex(file)) {
          ctx.events.onFileFinished(file, "skipped");
          return;
        }
      }
      mkdirSync(dirname(file.finalPath), { recursive: true });
      if (
        file.size <= hfChunkBytes(file.size, ctx.tuning) ||
        maxConnections <= 1
      ) {
        engine.singleQueue.push(file);
        return;
      }
      const state = await prepareChunkedFile(file);
      ctx.events.onFileStart(file.path);
      reportBytes(state);
      ctx.fileAborts.set(file.path, () => {
        state.canceled = true;
        for (const controller of state.controllers) {
          controller.abort();
        }
        wake();
      });
      engine.openFiles.push(state);
    } catch (error) {
      if (ctx.signal.aborted) {
        return;
      }
      const message = (error as Error).message;
      if (isEnospc(error)) {
        engine.fatalError = message;
      } else {
        engine.failedCount += 1;
      }
      ctx.events.onFileFailed(file.path, message);
      logger.warn(
        { repoId: ctx.repoId, path: file.path, err: error },
        "hf file download failed",
      );
    }
  }

  function nextWork(): Work {
    for (const state of engine.openFiles) {
      if (state.canceled && state.controllers.size === 0) {
        void settleCanceled(state);
        continue;
      }
      if (state.canceled || state.settled) {
        continue;
      }
      let index = state.nextChunkIndex;
      while (index < state.chunkCount && state.claimed.has(index)) {
        index += 1;
      }
      state.nextChunkIndex = index;
      if (index < state.chunkCount) {
        state.claimed.add(index);
        state.nextChunkIndex = index + 1;
        return { kind: "chunk", state, index };
      }
    }
    const single = engine.singleQueue.shift();
    if (single) {
      return { kind: "single", file: single };
    }
    if (engine.nextFileIndex < ctx.planned.length) {
      if (engine.opening) {
        return "wait";
      }
      return "open";
    }
    if (engine.opening || engine.busy > 0) {
      return "wait";
    }
    return "done";
  }

  async function worker(workerIndex: number): Promise<void> {
    for (;;) {
      if (
        ctx.signal.aborted ||
        engine.fatalError !== null ||
        engine.stalled !== null ||
        engine.done
      ) {
        return;
      }
      if (workerIndex >= engine.targetConnections) {
        await waitForWake();
        continue;
      }
      const work = nextWork();
      if (work === "done") {
        engine.done = true;
        wake();
        return;
      }
      if (work === "wait") {
        await waitForWake();
        continue;
      }
      engine.busy += 1;
      try {
        if (work === "open") {
          engine.opening = true;
          try {
            await openNextFile();
          } finally {
            engine.opening = false;
          }
        } else if (work.kind === "chunk") {
          await runChunk(work.state, work.index);
        } else {
          await runSingleFile(work.file);
        }
      } finally {
        engine.busy -= 1;
        wake();
      }
    }
  }

  try {
    await Promise.all(
      Array.from({ length: maxConnections }, (_, index) => worker(index)),
    );
  } finally {
    ctx.signal.removeEventListener("abort", wake);
    for (const state of [...engine.openFiles]) {
      for (const controller of state.controllers) {
        controller.abort();
      }
      await closeState(state);
      ctx.fileAborts.delete(state.file.path);
    }
  }
  return {
    failedCount: engine.failedCount,
    fatalError: engine.fatalError,
    stalled: engine.stalled,
  };
}
