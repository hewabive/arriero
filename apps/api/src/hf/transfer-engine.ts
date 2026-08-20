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
import { hfDownloadFetch } from "./http.js";
import type { HfManifestFile } from "./manifest.js";

const CHUNK_ATTEMPT_LIMIT = 5;
const RATE_LIMIT_DELAYS_MS = [30_000, 60_000];

type HfTransferEvents = {
  onFileStart: (path: string) => void;
  onFileBytes: (path: string, bytes: number) => void;
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
  connections: number;
  chunkBytes: number;
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
  const message = error instanceof Error ? error.message : String(error);
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
  manifestEntry: HfManifestFile | null;
  onBytes: (bytes: number) => void;
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
  const fetchImpl = clientOptions.fetchImpl ?? hfDownloadFetch;
  let response: Response;
  try {
    response = await fetchImpl(ctx.url, {
      headers,
      signal,
      redirect: "follow",
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
      const buffer = Buffer.from(chunk);
      hash.update(buffer);
      received += buffer.length;
      ctx.onBytes(received);
      if (!out.write(buffer)) {
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
  canceled: boolean;
  closed: boolean;
  switchedToSingle: boolean;
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
    ctx.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const engine = {
    failedCount: 0,
    fatalError: null as string | null,
    stalled: null as string | null,
    progressStamp: 0,
    nextFileIndex: 0,
    opening: false,
    busy: 0,
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
    state.switchedToSingle = true;
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
    let chunkBytes = ctx.chunkBytes;
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
      canceled: false,
      closed: false,
      switchedToSingle: false,
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
    const fetchImpl = ctx.clientOptions.fetchImpl ?? hfDownloadFetch;
    let response: Response;
    try {
      response = await fetchImpl(url, { headers, signal, redirect: "follow" });
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
      throw new RangeUnsupportedError();
    }
    if (!response.ok) {
      throw await hfErrorFromResponse(response);
    }
    if (response.status !== 206) {
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
    const body = response.body as unknown as AsyncIterable<Uint8Array>;
    try {
      for await (const chunk of body) {
        const buffer = Buffer.from(chunk);
        received += buffer.length;
        if (received > size) {
          throw new HfHubError(
            "upstream",
            response.status,
            `server sent more bytes than requested for ${state.file.path}`,
          );
        }
        await state.handle.write(buffer, 0, buffer.length, position);
        position += buffer.length;
        progress.flushed = received;
        if (buffer.length > 0) {
          engine.progressStamp += 1;
        }
        state.liveByChunk.set(index, received);
        reportBytes(state);
      }
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      throw asTransportError(error, state.file.path);
    }
    if (received !== size) {
      throw new HfHubError(
        "network",
        null,
        `incomplete chunk of ${state.file.path}: got ${received} of ${size} bytes`,
      );
    }
  }

  async function runChunk(state: ChunkedFile, index: number): Promise<void> {
    let attempt = 0;
    let rateLimited = 0;
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
          const delay = RATE_LIMIT_DELAYS_MS[rateLimited];
          if (delay !== undefined) {
            rateLimited += 1;
            await sleep(delay);
            continue;
          }
          engine.fatalError = error.message;
          await settleFailed(state, error.message);
          abortActiveTransfers();
          return;
        }
        if (isEnospc(error)) {
          engine.fatalError = (error as Error).message;
          await settleFailed(state, (error as Error).message);
          abortActiveTransfers();
          return;
        }
        if (isTransientError(error)) {
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
            manifestEntry: ctx.manifestEntries.get(file.path) ?? null,
            onBytes: (bytes) => {
              const capped = Math.min(bytes, file.size);
              if (capped > reportedBytes) {
                reportedBytes = capped;
                engine.progressStamp += 1;
              }
              ctx.events.onFileBytes(file.path, capped);
            },
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
          if (isTransientError(error) && !isEnospc(error)) {
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
          if (
            isFatalAuthError(error) ||
            isEnospc(error) ||
            (error instanceof HfHubError && error.kind === "rate-limited")
          ) {
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
      if (file.size <= ctx.chunkBytes || ctx.connections <= 1) {
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
      for (let index = 0; index < state.chunkCount; index += 1) {
        if (!state.claimed.has(index)) {
          state.claimed.add(index);
          return { kind: "chunk", state, index };
        }
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

  async function worker(): Promise<void> {
    for (;;) {
      if (
        ctx.signal.aborted ||
        engine.fatalError !== null ||
        engine.stalled !== null
      ) {
        return;
      }
      const work = nextWork();
      if (work === "done") {
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
    const workerCount = Math.max(1, Math.min(ctx.connections, 16));
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
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
