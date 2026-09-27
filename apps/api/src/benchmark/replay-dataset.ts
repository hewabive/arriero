import { createHash } from "node:crypto";

import type {
  BenchmarkContextFit,
  BenchmarkReplayScenario,
  Instance,
  WorkloadDatasetManifest,
  WorkloadDatasetRecord,
  WorkloadDatasetSegment,
} from "@arriero/core";

import { instanceBaseUrl } from "../instances/endpoint.js";
import { getInstance } from "../instances/repository.js";
import { logger } from "../logger.js";
import { latestProcessRun } from "../process/runs-repository.js";
import { runtimeEndpointInstance } from "../process/runtime-endpoint.js";
import {
  prepareRecordedRequestForInstance,
  recordedRequestOperation,
  type PreparedRecordedRequest,
} from "../proxy/recorded-request.js";
import { countInstancePromptTokens } from "../proxy/token-count.js";
import { canonicalize } from "../utils/canonical-json.js";
import {
  rebuildWorkloadBody,
  workloadBlobHash,
  workloadContentBlobHashes,
  workloadDatasetId,
} from "../workload/dataset-codec.js";
import {
  readWorkloadDatasetBlobJson,
  readWorkloadDatasetManifest,
} from "../workload/dataset-store.js";
import {
  checkDatasetContextFit,
  probeInstanceContextTokens,
} from "./context-check.js";
import { BenchmarkNotFoundError } from "./errors.js";
import { resolveEndpointModel } from "./run-support.js";

export type DatasetBlobs = Map<string, string>;

const REPLAY_CHAT_PATH = "/v1/chat/completions";
const COUNT_TIMEOUT_MS = 30 * 1000;
const PRIMING_HIT_SHARE = 0.5;
const PER_RUN_BODY_FIELDS = [
  "model",
  "stream",
  "stream_options",
  "max_tokens",
  "max_completion_tokens",
  "temperature",
  "seed",
];

export function loadReplayDataset(
  scenario: BenchmarkReplayScenario,
): WorkloadDatasetManifest {
  const manifest = readWorkloadDatasetManifest(scenario.datasetId);
  if (!manifest) {
    throw new BenchmarkNotFoundError(
      `workload dataset ${scenario.datasetId} not found`,
    );
  }
  if (
    manifest.id !== scenario.datasetId ||
    workloadDatasetId(manifest.content) !== scenario.datasetId
  ) {
    throw new Error(
      `workload dataset ${scenario.datasetId} does not match its content hash`,
    );
  }
  const windows = manifest.content.selection.windows.length;
  if (scenario.arrival.kind === "recorded" && windows > 1) {
    throw new Error(
      `the recorded arrival plan replays one window, and dataset "${manifest.meta.name}" holds ${windows}; choose a composed arrival plan`,
    );
  }
  return manifest;
}

export async function loadDatasetBlobs(
  manifest: WorkloadDatasetManifest,
): Promise<DatasetBlobs> {
  const blobs: DatasetBlobs = new Map();
  for (const hash of workloadContentBlobHashes(manifest.content)) {
    const json = await readWorkloadDatasetBlobJson(manifest.id, hash);
    if (workloadBlobHash(json) !== hash) {
      throw new Error(`dataset blob ${hash} does not match its hash`);
    }
    blobs.set(hash, json);
  }
  return blobs;
}

function recordedBody(
  blobs: DatasetBlobs,
  record: WorkloadDatasetRecord,
): Record<string, unknown> {
  return rebuildWorkloadBody(record.body, (hash) => {
    const json = blobs.get(hash);
    if (json === undefined) {
      throw new Error(`dataset blob ${hash} is missing`);
    }
    return JSON.parse(json) as unknown;
  });
}

export function prepareReplayRecord(
  instance: Instance,
  blobs: DatasetBlobs,
  record: WorkloadDatasetRecord,
): PreparedRecordedRequest {
  const prepared = prepareRecordedRequestForInstance(instance, {
    protocol: record.protocol,
    endpoint: record.endpoint,
    routePath: record.routePath,
    body: recordedBody(blobs, record),
  });
  if (!prepared.ok) {
    throw new Error(
      `record ${record.traceId} cannot be prepared for ${instance.name}: ${prepared.error}`,
    );
  }
  if (prepared.request.path !== REPLAY_CHAT_PATH) {
    throw new Error(
      `record ${record.traceId} prepares to ${prepared.request.path}, and replay measures ${REPLAY_CHAT_PATH} streams`,
    );
  }
  return prepared.request;
}

function segmentRecords(
  segment: WorkloadDatasetSegment,
): WorkloadDatasetRecord[] {
  return segment.priming
    ? [segment.priming, ...segment.records]
    : segment.records;
}

export function preparedBodyHash(
  instance: Instance,
  blobs: DatasetBlobs,
  segments: readonly WorkloadDatasetSegment[],
): string {
  const hash = createHash("sha256");
  for (const segment of segments) {
    for (const record of segmentRecords(segment)) {
      const prepared = prepareReplayRecord(instance, blobs, record);
      const body = { ...prepared.body };
      for (const field of PER_RUN_BODY_FIELDS) {
        delete body[field];
      }
      hash.update(JSON.stringify(canonicalize([prepared.path, body])));
      hash.update("\n");
    }
  }
  return hash.digest("hex");
}

function primingWanted(
  segment: WorkloadDatasetSegment,
  policy: BenchmarkReplayScenario["priming"],
): boolean {
  if (!segment.priming || policy === "none") {
    return false;
  }
  if (policy === "all") {
    return true;
  }
  const cached = segment.records[0]?.cacheReadTokens ?? null;
  const primingPrompt = segment.priming.promptTokens;
  return (
    cached === null ||
    primingPrompt === null ||
    cached >= primingPrompt * PRIMING_HIT_SHARE
  );
}

export function primedSegmentIndexes(
  segments: readonly WorkloadDatasetSegment[],
  policy: BenchmarkReplayScenario["priming"],
): number[] {
  const endedAt = (index: number) => {
    const value = segments[index]?.primingEndedAt;
    const ms = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(ms) ? ms : 0;
  };
  return segments
    .flatMap((segment, index) =>
      primingWanted(segment, policy) ? [index] : [],
    )
    .sort((left, right) => endedAt(left) - endedAt(right) || left - right);
}

async function probeContextTokens(input: {
  instance: Instance;
  baseUrl: string;
  model: string | null;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<number | null> {
  try {
    return await probeInstanceContextTokens(input);
  } catch (error) {
    logger.warn(
      { instance: input.instance.name, error: (error as Error).message },
      "benchmark context probe failed",
    );
    return null;
  }
}

export async function datasetContextFit(input: {
  manifest: WorkloadDatasetManifest;
  blobs: DatasetBlobs;
  instance: Instance;
  baseUrl: string;
  model: string | null;
  outputCeiling: number;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<BenchmarkContextFit> {
  const { instance, fetchImpl, signal } = input;
  return checkDatasetContextFit({
    manifest: input.manifest,
    contextTokens: await probeContextTokens(input),
    outputCeiling: input.outputCeiling,
    countTokens: async (record) => {
      const counted = await countInstancePromptTokens(
        instance,
        {
          operation: recordedRequestOperation(record),
          body: recordedBody(input.blobs, record),
        },
        { fetchImpl, signal, timeoutMs: COUNT_TIMEOUT_MS },
      );
      if (!counted.ok) {
        return null;
      }
      return "tokens" in counted ? counted.tokens : counted.minimumTokens;
    },
  });
}

export function contextOverflowMessage(
  fit: BenchmarkContextFit,
): string | null {
  const overflow = fit.segments.filter((segment) => segment.fits === false);
  if (overflow.length === 0) {
    return null;
  }
  const listed = overflow
    .map((segment) => `${segment.sessionId} (${segment.promptTokens} tokens)`)
    .join(", ");
  return `${overflow.length} segments do not fit the context of ${fit.contextTokens} tokens with the output ceiling of ${fit.outputCeiling}: ${listed}`;
}

export async function checkReplayDatasetFit(input: {
  datasetId: string;
  instanceName: string;
  outputCeiling: number;
  fetchImpl?: typeof fetch | undefined;
  signal?: AbortSignal | undefined;
}): Promise<BenchmarkContextFit> {
  const manifest = readWorkloadDatasetManifest(input.datasetId);
  if (!manifest) {
    throw new BenchmarkNotFoundError(
      `workload dataset ${input.datasetId} not found`,
    );
  }
  const instance = getInstance(input.instanceName);
  if (!instance) {
    throw new BenchmarkNotFoundError(
      `instance ${input.instanceName} not found`,
    );
  }
  const baseUrl = instanceBaseUrl(
    runtimeEndpointInstance(instance, latestProcessRun(instance.name)),
  );
  if (!baseUrl) {
    throw new Error(`instance ${instance.name} has no HTTP endpoint`);
  }
  const fetchImpl = input.fetchImpl ?? fetch;
  const signal = input.signal ?? new AbortController().signal;
  const blobs = await loadDatasetBlobs(manifest);
  const model = await resolveEndpointModel({ baseUrl, fetchImpl, signal });
  return datasetContextFit({
    manifest,
    blobs,
    instance,
    baseUrl,
    model,
    outputCeiling: input.outputCeiling,
    fetchImpl,
    signal,
  });
}
