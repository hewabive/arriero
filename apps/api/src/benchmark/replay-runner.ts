import {
  engineDescriptor,
  type BenchmarkReplayScenario,
  type BenchmarkReplaySnapshot,
  type BenchmarkRunPhase,
  type Instance,
  type WorkloadDatasetManifest,
  type WorkloadDatasetRecord,
  type WorkloadDatasetSegment,
} from "@arriero/core";

import { getInstance } from "../instances/repository.js";
import { hasLaunchSnapshotDrift } from "../process/launch-snapshot.js";
import { restartManagedInstance } from "../process/managed-lifecycle.js";
import type { PreparedRecordedRequest } from "../proxy/recorded-request.js";
import {
  apiProxyReservationScope,
  reserveApiProxyInstances,
  type ApiProxyReservationHandle,
} from "../proxy/run-reservation.js";
import { newId } from "../utils/id.js";
import {
  flushBenchmarkInstanceCache,
  waitForBenchmarkEndpointReady,
} from "./cache-flush.js";
import { BenchmarkLoadCollector } from "./load-statistics.js";
import {
  runMeasuredRequest,
  type MeasuredStreamOutcome,
} from "./measure-client.js";
import { analyzeReplayRequests, replayRequestId } from "./replay-analysis.js";
import {
  contextOverflowMessage,
  datasetContextFit,
  loadDatasetBlobs,
  preparedBodyHash,
  primedSegmentIndexes,
  replayRecordPreparer,
  type DatasetBlobs,
  type ReplayRecordPreparer,
} from "./replay-dataset.js";
import {
  realReplayClock,
  replayStartOffsets,
  replayThinkTimeMs,
  runReplaySchedule,
  type ReplayClock,
  type ReplaySegmentPlan,
} from "./replay-schedule.js";
import {
  createBenchmarkEventWriter,
  patchBenchmarkRun,
  writeBenchmarkRunResult,
  type BenchmarkEventWriter,
} from "./repository.js";
import {
  benchmarkEndpoint,
  benchmarkStreamEvents,
  benchmarkTargetSnapshot,
  clearBenchmarkRunProgress,
  closeBenchmarkEvents,
  failBenchmarkRun,
  fetchServerProps,
  LAUNCH_DRIFT_WARNING,
  nowIso,
  persistRunRecord,
  resolveEndpointModel,
  setBenchmarkRunProgress,
  streamingRunFields,
  WARMUP_MAX_TOKENS,
  type BenchmarkRunContext,
  type BenchmarkTarget,
} from "./run-support.js";
import { weightedAcceptance, type MeasuredRequest } from "./segmenter.js";

export type ReplayRunnerOptions = {
  restartInstance?: ((instance: Instance) => Promise<void>) | undefined;
  replayClock?: ReplayClock | undefined;
  drainTimeoutMs?: number | undefined;
  readyTimeoutMs?: number | undefined;
};

type ReplayExecutionContext = BenchmarkRunContext & {
  scenario: BenchmarkReplayScenario;
  manifest: WorkloadDatasetManifest;
  options: ReplayRunnerOptions;
};

type ReplayRun = {
  context: ReplayExecutionContext;
  segments: readonly WorkloadDatasetSegment[];
  target: BenchmarkTarget;
  prepare: ReplayRecordPreparer;
  blobs: DatasetBlobs;
  primedSegments: number[];
  replay: BenchmarkReplaySnapshot | null;
  warnings: string[];
  progress: {
    phase: BenchmarkRunPhase;
    completedRequests: number;
    totalRequests: number;
    activeRequests: number;
  };
  flushUnverified: boolean;
  load: BenchmarkLoadCollector;
  reservation: ApiProxyReservationHandle | null;
  eventWriter: BenchmarkEventWriter | null;
};

const DEFAULT_DRAIN_TIMEOUT_MS = 5 * 60 * 1000;
const PRIMING_MAX_TOKENS = 1;
const FLUSH_VERIFICATION_MIN_TOKENS = 64;
const FLUSH_VERIFICATION_SHARE = 0.01;

function recordCount(segments: readonly WorkloadDatasetSegment[]): number {
  return segments.reduce((total, segment) => total + segment.records.length, 0);
}

function segmentPlans(
  segments: readonly WorkloadDatasetSegment[],
): ReplaySegmentPlan[] {
  return segments.map((segment) => ({
    startOffsetMs: segment.records[0]?.offsetMs ?? 0,
    thinkTimesMs: segment.records.map((record) => record.thinkTimeMs),
  }));
}

function estimatedReplayMs(
  scenario: BenchmarkReplayScenario,
  segments: readonly WorkloadDatasetSegment[],
): number {
  const offsets = replayStartOffsets(segmentPlans(segments), scenario.arrival);
  let longest = 0;
  segments.forEach((segment, index) => {
    const busy = segment.records.reduce(
      (total, record, recordIndex) =>
        total +
        record.durationMs +
        (recordIndex > 0
          ? replayThinkTimeMs(record.thinkTimeMs, scenario.thinkTime)
          : 0),
      0,
    );
    longest = Math.max(longest, (offsets[index] ?? 0) + busy);
  });
  return longest;
}

function recordedOutputLimit(body: Record<string, unknown>): number | null {
  const limits = [body.max_tokens, body.max_completion_tokens].filter(
    (value): value is number => typeof value === "number" && value > 0,
  );
  return limits.length > 0 ? Math.min(...limits) : null;
}

function outputLimit(
  scenario: BenchmarkReplayScenario,
  record: WorkloadDatasetRecord,
  body: Record<string, unknown>,
): number {
  const recorded = recordedOutputLimit(body);
  const limit =
    recorded === null
      ? scenario.outputCeiling
      : Math.min(recorded, scenario.outputCeiling);
  if (
    scenario.imitateClientAborts &&
    record.outcome === "client-abort" &&
    record.completionTokens !== null
  ) {
    return Math.min(limit, Math.max(1, record.completionTokens));
  }
  return limit;
}

function replayRequestBody(input: {
  prepared: PreparedRecordedRequest;
  model: string | null;
  maxTokens: number;
  sampling: BenchmarkReplayScenario["sampling"];
}): Record<string, unknown> {
  const body: Record<string, unknown> = { ...input.prepared.body };
  const completionLimit = "max_completion_tokens" in body;
  if (completionLimit) {
    body.max_completion_tokens = input.maxTokens;
  }
  if (!completionLimit || "max_tokens" in body) {
    body.max_tokens = input.maxTokens;
  }
  return { ...body, ...streamingRunFields(input.model, input.sampling) };
}

function warmupBody(model: string | null): Record<string, unknown> {
  return {
    ...streamingRunFields(model, undefined),
    messages: [
      {
        role: "user",
        content: `benchmark-nonce: ${newId()}\n\nName three colors.`,
      },
    ],
    max_tokens: WARMUP_MAX_TOKENS,
  };
}

function flushVerification(
  outcome: Pick<MeasuredStreamOutcome, "promptTokens" | "cachedPromptTokens">,
): NonNullable<BenchmarkReplaySnapshot["flush"]>["verification"] {
  const { promptTokens, cachedPromptTokens } = outcome;
  if (promptTokens === null || cachedPromptTokens === null) {
    return "unverified";
  }
  const tolerance = Math.max(
    FLUSH_VERIFICATION_MIN_TOKENS,
    promptTokens * FLUSH_VERIFICATION_SHARE,
  );
  return cachedPromptTokens <= tolerance ? "passed" : "failed";
}

function endpointProbe(run: ReplayRun) {
  return {
    baseUrl: run.target.baseUrl,
    fetchImpl: run.context.fetchImpl,
    signal: run.context.signal,
  };
}

function publishSnapshot(run: ReplayRun): void {
  patchBenchmarkRun(run.context.runId, {
    snapshot: {
      ...benchmarkTargetSnapshot(run.target),
      ...(run.replay ? { replay: run.replay } : {}),
    },
  });
}

function publishProgress(run: ReplayRun): void {
  setBenchmarkRunProgress(run.context.runId, {
    ...run.progress,
    repetition: 0,
  });
}

function enterPhase(
  run: ReplayRun,
  phase: BenchmarkRunPhase,
  totalRequests = recordCount(run.segments),
): void {
  run.progress = {
    phase,
    completedRequests: 0,
    totalRequests,
    activeRequests: 0,
  };
  publishProgress(run);
}

function updateReplaySnapshot(
  run: ReplayRun,
  patch: Partial<BenchmarkReplaySnapshot>,
): void {
  if (run.replay) {
    run.replay = { ...run.replay, ...patch };
    publishSnapshot(run);
  }
}

async function prepareReplay(run: ReplayRun): Promise<void> {
  const { manifest, scenario, runId, signal, options } = run.context;
  const target = run.target;
  enterPhase(run, "prepare");
  run.blobs = await loadDatasetBlobs(manifest);
  target.model = await resolveEndpointModel(endpointProbe(run));
  target.buildInfo =
    engineDescriptor(target.instance.kind).nativeApi === "llama"
      ? ((await fetchServerProps(endpointProbe(run)))?.buildInfo ?? null)
      : null;
  run.replay = {
    datasetId: manifest.id,
    datasetName: manifest.meta.name,
    preparedBodyHash: preparedBodyHash(run.prepare, run.blobs, run.segments),
    segmentCount: run.segments.length,
    recordCount: recordCount(run.segments),
    primedSegmentCount: run.primedSegments.length,
    contextTokens: null,
    reservedInstances: [],
    flush: null,
  };
  publishSnapshot(run);

  const fit = await datasetContextFit({
    manifest,
    blobs: run.blobs,
    instance: target.instance,
    baseUrl: target.baseUrl,
    model: target.model,
    outputCeiling: scenario.outputCeiling,
    fetchImpl: run.context.fetchImpl,
    signal,
  });
  run.warnings.push(...fit.warnings);
  updateReplaySnapshot(run, { contextTokens: fit.contextTokens });
  const overflow = contextOverflowMessage(fit);
  if (overflow) {
    throw new Error(overflow);
  }
  if (
    scenario.idleSkipping &&
    target.runtimeArgs["--sleep-idle-seconds"] !== undefined
  ) {
    run.warnings.push(
      "the instance sleeps after --sleep-idle-seconds; idle skipping never lets it sleep, while real work may have",
    );
  }
  if (!apiProxyReservationScope(target.instance.name).drawsDeclared) {
    run.warnings.push(
      "the instance declares no memory-pool draws, so neighbors sharing its hardware are unknown and were not reserved",
    );
  }
  run.reservation = await reserveApiProxyInstances({
    runId,
    label: scenario.label ?? runId,
    instanceName: target.instance.name,
    expectedEndAt: new Date(
      Date.now() + estimatedReplayMs(scenario, run.segments),
    ).toISOString(),
    drainTimeoutMs: options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS,
    signal,
  });
  updateReplaySnapshot(run, {
    reservedInstances: run.reservation.reservation.instanceNames,
  });
}

async function restartReplayTarget(run: ReplayRun): Promise<void> {
  const { options, fetchImpl, signal } = run.context;
  const target = run.target;
  target.instance = getInstance(target.instance.name) ?? target.instance;
  run.prepare = replayRecordPreparer(target.instance);
  if (options.restartInstance) {
    await options.restartInstance(target.instance);
  } else {
    await restartManagedInstance(target.instance);
  }
  const endpoint = benchmarkEndpoint(target.instance);
  target.baseUrl = endpoint.baseUrl || target.baseUrl;
  target.runtimeArgs = endpoint.runtimeArgs;
  target.launch = endpoint.launch;
  await waitForBenchmarkEndpointReady({
    baseUrl: target.baseUrl,
    fetchImpl,
    signal,
    timeoutMs: options.readyTimeoutMs,
  });
}

async function flushReplayCache(run: ReplayRun): Promise<void> {
  const target = run.target;
  enterPhase(run, "flush");
  const flushed = await flushBenchmarkInstanceCache({
    instance: target.instance,
    baseUrl: target.baseUrl,
    model: target.model,
    launchCliArgs: target.launch?.cliArgs ?? null,
    launchEnv: target.launch?.env ?? target.instance.env,
    fetchImpl: run.context.fetchImpl,
    signal: run.context.signal,
    restart: () => restartReplayTarget(run),
  });
  if (flushed.method === "restart") {
    target.model = await resolveEndpointModel(endpointProbe(run));
  } else if (
    target.launch &&
    hasLaunchSnapshotDrift(target.instance, target.launch)
  ) {
    run.warnings.push(LAUNCH_DRIFT_WARNING);
  }
  updateReplaySnapshot(run, {
    flush: {
      method: flushed.method,
      detail: flushed.detail,
      verification: null,
      promptTokens: null,
      cachedPromptTokens: null,
    },
  });
}

function verifyFlush(run: ReplayRun, outcome: MeasuredStreamOutcome): void {
  run.flushUnverified = false;
  const verification = flushVerification(outcome);
  if (run.replay?.flush) {
    updateReplaySnapshot(run, {
      flush: {
        ...run.replay.flush,
        verification,
        promptTokens: outcome.promptTokens,
        cachedPromptTokens: outcome.cachedPromptTokens,
      },
    });
  }
  if (verification === "unverified") {
    run.warnings.push(
      "the engine reports no cached prompt tokens, so the cache flush could not be verified",
    );
  }
  if (verification === "failed") {
    throw new Error(
      `the engine cache was not flushed: the first dataset request read ${outcome.cachedPromptTokens} of ${outcome.promptTokens} prompt tokens from the cache`,
    );
  }
}

async function warmUpReplay(run: ReplayRun): Promise<void> {
  const { scenario, signal, fetchImpl } = run.context;
  enterPhase(run, "warmup");
  const warmup = await runMeasuredRequest({
    url: `${run.target.baseUrl}/v1/chat/completions`,
    body: warmupBody(run.target.model),
    signal,
    timeoutMs: scenario.requestTimeoutMs,
    fetchImpl,
    requireContent: false,
  });
  if (warmup.error !== null && !signal.aborted) {
    throw new Error(`warmup request failed: ${warmup.error}`);
  }
}

async function primeReplaySegments(run: ReplayRun): Promise<void> {
  const { scenario, signal, fetchImpl } = run.context;
  enterPhase(run, "priming", run.primedSegments.length);
  for (const segmentIndex of run.primedSegments) {
    const segment = run.segments[segmentIndex];
    const record = segment?.priming;
    if (!segment || !record) {
      continue;
    }
    const prepared = run.prepare(run.blobs, record);
    const outcome = await runMeasuredRequest({
      url: `${run.target.baseUrl}${prepared.path}`,
      body: replayRequestBody({
        prepared,
        model: run.target.model,
        maxTokens: PRIMING_MAX_TOKENS,
        sampling: scenario.sampling,
      }),
      signal,
      timeoutMs: scenario.requestTimeoutMs,
      fetchImpl,
      omittedCacheReadIsZero: prepared.omittedCacheReadIsZero,
      requireContent: false,
    });
    if (outcome.error !== null) {
      throw new Error(
        `priming request of session ${segment.sessionId} (trace ${record.traceId}) failed: ${outcome.error}`,
      );
    }
    if (run.flushUnverified) {
      verifyFlush(run, outcome);
    }
    run.progress.completedRequests += 1;
    publishProgress(run);
  }
}

async function measureReplay(run: ReplayRun): Promise<void> {
  const { scenario, signal, fetchImpl, runId, options } = run.context;
  enterPhase(run, "measure");
  const writer = await createBenchmarkEventWriter(runId);
  run.eventWriter = writer;
  const epoch = performance.now();
  const now = () => performance.now() - epoch;
  let ceilingCuts = 0;
  await runReplaySchedule({
    segments: segmentPlans(run.segments),
    arrival: scenario.arrival,
    thinkTime: scenario.thinkTime,
    idleSkipping: scenario.idleSkipping,
    clock: options.replayClock ?? realReplayClock,
    signal,
    send: async ({ segmentIndex, recordIndex }, requestSignal) => {
      const segment = run.segments[segmentIndex];
      const record = segment?.records[recordIndex];
      if (!segment || !record) {
        throw new Error(
          `replay request ${segmentIndex}:${recordIndex} is not in the dataset`,
        );
      }
      const prepared = run.prepare(run.blobs, record);
      const maxTokens = outputLimit(scenario, record, prepared.body);
      const verifies = run.flushUnverified;
      run.flushUnverified = false;
      run.progress.activeRequests += 1;
      publishProgress(run);
      try {
        const outcome = await runMeasuredRequest({
          url: `${run.target.baseUrl}${prepared.path}`,
          body: replayRequestBody({
            prepared,
            model: run.target.model,
            maxTokens,
            sampling: scenario.sampling,
          }),
          signal: requestSignal,
          timeoutMs: scenario.requestTimeoutMs,
          fetchImpl,
          now,
          omittedCacheReadIsZero: prepared.omittedCacheReadIsZero,
          requireContent: false,
        });
        const measured: MeasuredRequest = {
          requestId: replayRequestId({ segmentIndex, recordIndex }),
          promptId: segment.sessionId,
          topic: `segment ${segmentIndex + 1}`,
          language: `turn ${recordIndex + 1}`,
          repetition: 0,
          ...outcome,
        };
        run.load.record(measured);
        await writer.append(benchmarkStreamEvents([measured]));
        if (
          outcome.finishReason === "length" &&
          maxTokens === scenario.outputCeiling
        ) {
          ceilingCuts += 1;
        }
        if (outcome.error !== null) {
          throw new Error(
            `request ${recordIndex + 1} of session ${segment.sessionId} (trace ${record.traceId}) failed: ${outcome.error}`,
          );
        }
        if (verifies) {
          verifyFlush(run, outcome);
        }
      } finally {
        run.progress.activeRequests -= 1;
        run.progress.completedRequests += 1;
        publishProgress(run);
      }
    },
  });
  await writer.close();
  if (ceilingCuts > 0) {
    run.warnings.push(
      `${ceilingCuts} answers were cut at the output ceiling of ${scenario.outputCeiling} tokens`,
    );
  }
}

function replayAnalysis(run: ReplayRun) {
  const analysis = run.load.analyze();
  const replay = analyzeReplayRequests({
    segments: run.segments,
    primedSegments: new Set(run.primedSegments),
    requests: analysis.result.requests,
    recordedArrival: run.context.scenario.arrival.kind === "recorded",
  });
  return {
    result: {
      ...analysis.result,
      ...(replay.fidelity ? { fidelity: replay.fidelity } : {}),
    },
    summary: {
      ...analysis.summary,
      acceptanceRate: weightedAcceptance(analysis.result.requests),
      replay: replay.summary,
    },
  };
}

function finalizeReplay(run: ReplayRun): void {
  const { runId } = run.context;
  run.progress = { ...run.progress, phase: "finalize", activeRequests: 0 };
  publishProgress(run);
  const { result, summary } = replayAnalysis(run);
  writeBenchmarkRunResult(runId, result);
  patchBenchmarkRun(runId, {
    status: "succeeded",
    finishedAt: nowIso(),
    warnings: run.warnings,
    summary,
    error: null,
  });
  persistRunRecord(runId);
}

export async function executeReplayRun(
  context: ReplayExecutionContext,
): Promise<void> {
  const segments = context.manifest.content.segments;
  const run: ReplayRun = {
    context,
    segments,
    target: {
      instance: context.instance,
      runtimeArgs: context.runtimeArgs,
      launch: context.launch,
      baseUrl: context.baseUrl,
      model: null,
      buildInfo: null,
    },
    prepare: replayRecordPreparer(context.instance),
    blobs: new Map(),
    primedSegments: primedSegmentIndexes(segments, context.scenario.priming),
    replay: null,
    warnings: [],
    progress: {
      phase: "prepare",
      completedRequests: 0,
      totalRequests: recordCount(segments),
      activeRequests: 0,
    },
    flushUnverified: true,
    load: new BenchmarkLoadCollector(),
    reservation: null,
    eventWriter: null,
  };
  try {
    await prepareReplay(run);
    await flushReplayCache(run);
    if (context.scenario.warmup) {
      await warmUpReplay(run);
    }
    await primeReplaySegments(run);
    await measureReplay(run);
    finalizeReplay(run);
  } catch (error) {
    failBenchmarkRun({
      runId: context.runId,
      error,
      canceled: context.signal.aborted,
      warnings: run.warnings,
      measuredCount: run.load.requests.length,
      analyze: () => replayAnalysis(run),
      save: (result) => writeBenchmarkRunResult(context.runId, result),
    });
  } finally {
    run.reservation?.release();
    await closeBenchmarkEvents(context.runId, run.eventWriter);
    clearBenchmarkRunProgress(context.runId);
  }
}
