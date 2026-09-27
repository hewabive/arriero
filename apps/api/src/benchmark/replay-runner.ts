import {
  engineDescriptor,
  type BenchmarkReplayScenario,
  type BenchmarkReplaySnapshot,
  type BenchmarkRunPhase,
  type BenchmarkRunSummary,
  type Instance,
  type WorkloadDatasetManifest,
  type WorkloadDatasetRecord,
  type WorkloadDatasetSegment,
} from "@arriero/core";

import { instanceBaseUrl } from "../instances/endpoint.js";
import { getInstance } from "../instances/repository.js";
import { logger } from "../logger.js";
import {
  hasLaunchSnapshotDrift,
  type LaunchSnapshot,
} from "../process/launch-snapshot.js";
import { restartManagedInstance } from "../process/managed-lifecycle.js";
import { latestProcessRun } from "../process/runs-repository.js";
import {
  activeLaunchSnapshot,
  runtimeEndpointInstance,
} from "../process/runtime-endpoint.js";
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
import {
  analyzeReplayRequests,
  replayAcceptanceRate,
  replayRequestId,
} from "./replay-analysis.js";
import {
  contextOverflowMessage,
  datasetContextFit,
  loadDatasetBlobs,
  preparedBodyHash,
  prepareReplayRecord,
  primedSegmentIndexes,
  type DatasetBlobs,
} from "./replay-dataset.js";
import {
  realReplayClock,
  replayThinkTimeMs,
  runReplaySchedule,
  type ReplayArrivalPlan,
  type ReplayClock,
} from "./replay-schedule.js";
import {
  createBenchmarkEventWriter,
  patchBenchmarkRun,
  writeBenchmarkRunResult,
} from "./repository.js";
import {
  benchmarkStreamEvents,
  benchmarkTargetSnapshot,
  clearBenchmarkRunProgress,
  fetchServerProps,
  nowIso,
  persistRunRecord,
  resolveEndpointModel,
  setBenchmarkRunProgress,
} from "./run-support.js";
import type { MeasuredRequest } from "./segmenter.js";

export type ReplayRunnerOptions = {
  restartInstance: (instance: Instance) => Promise<void>;
  replayClock: ReplayClock;
  drainTimeoutMs: number;
  readyTimeoutMs: number;
};

type ReplayExecutionContext = {
  runId: string;
  scenario: BenchmarkReplayScenario;
  manifest: WorkloadDatasetManifest;
  instance: Instance;
  runtimeArgs: Instance["args"];
  launchSnapshot: LaunchSnapshot | null;
  baseUrl: string;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  options: Partial<ReplayRunnerOptions>;
};

type ReplayTarget = {
  instance: Instance;
  runtimeArgs: Instance["args"];
  launch: LaunchSnapshot | null;
  baseUrl: string;
  model: string | null;
  buildInfo: string | null;
};

type ReplayRun = {
  context: ReplayExecutionContext;
  segments: readonly WorkloadDatasetSegment[];
  target: ReplayTarget;
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
  eventWriter: Awaited<ReturnType<typeof createBenchmarkEventWriter>> | null;
};

const DEFAULT_DRAIN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_READY_TIMEOUT_MS = 10 * 60 * 1000;
const WARMUP_MAX_TOKENS = 32;
const PRIMING_MAX_TOKENS = 1;
const FLUSH_VERIFICATION_MIN_TOKENS = 64;
const FLUSH_VERIFICATION_SHARE = 0.01;

function recordCount(segments: readonly WorkloadDatasetSegment[]): number {
  return segments.reduce((total, segment) => total + segment.records.length, 0);
}

function arrivalPlan(scenario: BenchmarkReplayScenario): {
  arrival: ReplayArrivalPlan;
  concurrencyCap: number | null;
} {
  const arrival = scenario.arrival;
  switch (arrival.kind) {
    case "recorded":
      return { arrival: { kind: "recorded" }, concurrencyCap: null };
    case "together":
      return {
        arrival: { kind: "together" },
        concurrencyCap: arrival.concurrencyCap,
      };
    case "interval":
      return {
        arrival: { kind: "interval", intervalMs: arrival.intervalMs },
        concurrencyCap: arrival.concurrencyCap,
      };
  }
}

function segmentStartMs(
  scenario: BenchmarkReplayScenario,
  segment: WorkloadDatasetSegment,
  index: number,
): number {
  switch (scenario.arrival.kind) {
    case "recorded":
      return segment.records[0]?.offsetMs ?? 0;
    case "together":
      return 0;
    case "interval":
      return index * scenario.arrival.intervalMs;
  }
}

function estimatedReplayMs(
  scenario: BenchmarkReplayScenario,
  segments: readonly WorkloadDatasetSegment[],
): number {
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
    longest = Math.max(
      longest,
      segmentStartMs(scenario, segment, index) + busy,
    );
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
  return {
    ...body,
    ...(input.model !== null ? { model: input.model } : {}),
    stream: true,
    stream_options: { include_usage: true },
    ...(input.sampling?.temperature !== undefined
      ? { temperature: input.sampling.temperature }
      : {}),
    ...(input.sampling?.seed !== undefined
      ? { seed: input.sampling.seed }
      : {}),
  };
}

function warmupBody(model: string | null): Record<string, unknown> {
  return {
    ...(model !== null ? { model } : {}),
    messages: [
      {
        role: "user",
        content: `benchmark-nonce: ${newId()}\n\nName three colors.`,
      },
    ],
    stream: true,
    stream_options: { include_usage: true },
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
    preparedBodyHash: preparedBodyHash(
      target.instance,
      run.blobs,
      run.segments,
    ),
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
  if (options.restartInstance) {
    await options.restartInstance(target.instance);
  } else {
    await restartManagedInstance(target.instance);
  }
  const latestRun = latestProcessRun(target.instance.name);
  const runtime = runtimeEndpointInstance(target.instance, latestRun);
  target.baseUrl = instanceBaseUrl(runtime) || target.baseUrl;
  target.runtimeArgs = runtime.args;
  target.launch = activeLaunchSnapshot(target.instance.name, latestRun);
  await waitForBenchmarkEndpointReady({
    baseUrl: target.baseUrl,
    fetchImpl,
    signal,
    timeoutMs: options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS,
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
    run.warnings.push(
      "instance config drifted from the running process; the snapshot records the launched configuration",
    );
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
    const prepared = prepareReplayRecord(
      run.target.instance,
      run.blobs,
      record,
    );
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
  const plan = arrivalPlan(scenario);
  let ceilingCuts = 0;
  await runReplaySchedule({
    segments: run.segments.map((segment) => ({
      startOffsetMs: segment.records[0]?.offsetMs ?? 0,
      thinkTimesMs: segment.records.map((record) => record.thinkTimeMs),
    })),
    arrival: plan.arrival,
    thinkTime: scenario.thinkTime,
    concurrencyCap: plan.concurrencyCap,
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
      const prepared = prepareReplayRecord(
        run.target.instance,
        run.blobs,
        record,
      );
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
      acceptanceRate: replayAcceptanceRate(analysis.result.requests),
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

function failReplay(run: ReplayRun, error: unknown): void {
  const { runId, signal } = run.context;
  const message = (error as Error).message;
  logger.warn({ runId, error: message }, "benchmark replay run failed");
  let summary: BenchmarkRunSummary | null = null;
  if (run.load.requests.length > 0) {
    const analysis = replayAnalysis(run);
    summary = analysis.summary;
    try {
      writeBenchmarkRunResult(runId, analysis.result);
    } catch (artifactError) {
      logger.warn(
        { runId, error: (artifactError as Error).message },
        "benchmark partial artifacts could not be saved",
      );
    }
  }
  patchBenchmarkRun(runId, {
    ...(summary ? { summary } : {}),
    status: signal.aborted ? "canceled" : "failed",
    finishedAt: nowIso(),
    warnings: run.warnings,
    error: message,
  });
  if (summary) {
    persistRunRecord(runId);
  }
}

async function closeReplayEvents(run: ReplayRun): Promise<void> {
  try {
    await run.eventWriter?.close();
  } catch (error) {
    logger.warn(
      { runId: run.context.runId, error: (error as Error).message },
      "benchmark events could not be closed",
    );
  }
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
      launch: context.launchSnapshot,
      baseUrl: context.baseUrl,
      model: null,
      buildInfo: null,
    },
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
    failReplay(run, error);
  } finally {
    run.reservation?.release();
    await closeReplayEvents(run);
    clearBenchmarkRunProgress(context.runId);
  }
}
