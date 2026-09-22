import {
  engineDescriptor,
  type BenchmarkPromptWithSource,
  type BenchmarkRun,
  type BenchmarkRunProgress,
  type BenchmarkRunSummary,
  type BenchmarkScenario,
  type BenchmarkStreamEvent,
  type BenchmarkTargetSnapshot,
  type Instance,
} from "@arriero/core";

import { instanceBaseUrl } from "../instances/endpoint.js";
import { getInstance } from "../instances/repository.js";
import { getActiveJob, registerActiveJob } from "../jobs/registry.js";
import { logger } from "../logger.js";
import {
  hasLaunchSnapshotDrift,
  type LaunchSnapshot,
} from "../process/launch-snapshot.js";
import { latestProcessRun } from "../process/runs-repository.js";
import {
  activeLaunchSnapshot,
  runtimeEndpointInstance,
} from "../process/runtime-endpoint.js";
import { asObject, numberOrNull } from "../proxy/json.js";
import { newId } from "../utils/id.js";
import { BenchmarkConflictError, BenchmarkNotFoundError } from "./errors.js";
import {
  CANCELED_REQUEST_ERROR,
  runMeasuredRequest,
} from "./measure-client.js";
import { getBenchmarkPrompt } from "./prompts.js";
import {
  createBenchmarkEventWriter,
  createBenchmarkRun,
  getBenchmarkRun,
  patchBenchmarkRun,
  writeBenchmarkRunArtifacts,
  writeBenchmarkRunRecord,
  writeBenchmarkRunResult,
} from "./repository.js";
import { analyzeBenchmarkRun, type MeasuredRequest } from "./segmenter.js";
import { BenchmarkLoadCollector } from "./load-statistics.js";
import { runBenchmarkSchedule } from "./schedule.js";
import {
  benchmarkServerMetricsSource,
  type BenchmarkServerMetricsSource,
} from "./server-metrics.js";

export const BENCHMARK_JOB_DOMAIN = "benchmark";

const WARMUP_MAX_TOKENS = 32;

const activeProgress = new Map<string, BenchmarkRunProgress>();

export function getBenchmarkRunProgress(
  id: string,
): BenchmarkRunProgress | null {
  return activeProgress.get(id) ?? null;
}

export type BenchmarkRunnerOptions = {
  fetchImpl?: typeof fetch | undefined;
};

type PlannedRequest = {
  prompt: BenchmarkPromptWithSource;
};

type ExecutionContext = {
  runId: string;
  scenario: BenchmarkScenario;
  wave: PlannedRequest[];
  instance: Instance;
  runtimeArgs: Instance["args"];
  launchSnapshot: LaunchSnapshot | null;
  baseUrl: string;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  serverMetrics: BenchmarkServerMetricsSource | null;
};

function nowIso(): string {
  return new Date().toISOString();
}

function planWave(scenario: BenchmarkScenario): PlannedRequest[] {
  const wave: PlannedRequest[] = [];
  for (const entry of scenario.composition) {
    const prompt = getBenchmarkPrompt(entry.promptId);
    if (!prompt) {
      throw new BenchmarkNotFoundError(
        `benchmark prompt ${entry.promptId} not found`,
      );
    }
    for (let copy = 0; copy < entry.count; copy += 1) {
      wave.push({ prompt });
    }
  }
  return wave;
}

function chatRequestBody(input: {
  prompt: BenchmarkPromptWithSource;
  scenario: BenchmarkScenario;
  model: string | null;
  maxTokens: number;
}): unknown {
  const nonce = input.scenario.cacheBust ? newId() : null;
  const messages = input.prompt.messages.map((message, index) =>
    index === 0 && nonce
      ? {
          ...message,
          content: `benchmark-nonce: ${nonce}\n\n${message.content}`,
        }
      : message,
  );
  const sampling = input.scenario.sampling;
  return {
    ...(input.model !== null ? { model: input.model } : {}),
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: input.maxTokens,
    ...(sampling?.temperature !== undefined
      ? { temperature: sampling.temperature }
      : {}),
    ...(sampling?.seed !== undefined ? { seed: sampling.seed } : {}),
  };
}

async function resolveEndpointModel(
  context: ExecutionContext,
): Promise<string | null> {
  let response: Response;
  try {
    response = await context.fetchImpl(`${context.baseUrl}/v1/models`, {
      signal: context.signal,
    });
  } catch (error) {
    throw new Error(
      `instance endpoint is unreachable: ${(error as Error).message}`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `instance endpoint is not ready: GET /v1/models returned ${response.status}`,
    );
  }
  const body = asObject(await response.json().catch(() => null));
  const data = Array.isArray(body?.data) ? body.data : [];
  const first = asObject(data[0]);
  return typeof first?.id === "string" ? first.id : null;
}

type ServerProps = {
  totalSlots: number | null;
  buildInfo: string | null;
};

async function fetchServerProps(
  context: ExecutionContext,
): Promise<ServerProps | null> {
  try {
    const response = await context.fetchImpl(`${context.baseUrl}/props`, {
      signal: context.signal,
    });
    if (!response.ok) return null;
    const body = asObject(await response.json());
    return {
      totalSlots: numberOrNull(body?.total_slots),
      buildInfo: typeof body?.build_info === "string" ? body.build_info : null,
    };
  } catch (error) {
    logger.debug(
      { baseUrl: context.baseUrl, error: (error as Error).message },
      "benchmark props probe failed",
    );
    return null;
  }
}

function setProgress(
  runId: string,
  progress: BenchmarkRunProgress,
): BenchmarkRunProgress {
  activeProgress.set(runId, progress);
  return progress;
}

function persistRunRecord(runId: string): void {
  const run = getBenchmarkRun(runId);
  if (!run) {
    logger.warn({ runId }, "benchmark run record missing after finalize");
    return;
  }
  writeBenchmarkRunRecord(run);
}

function benchmarkStreamEvents(
  measured: readonly MeasuredRequest[],
): BenchmarkStreamEvent[] {
  const events: BenchmarkStreamEvent[] = [];
  for (const request of measured) {
    events.push({
      requestId: request.requestId,
      tMs: request.submitMs,
      kind: "submit",
    });
    if (request.firstTokenMs !== null) {
      events.push({
        requestId: request.requestId,
        tMs: request.firstTokenMs,
        kind: "first-token",
      });
    }
    for (const chunkMs of request.chunkTimesMs) {
      events.push({
        requestId: request.requestId,
        tMs: chunkMs,
        kind: "chunk",
      });
    }
    const endMs = request.endedMs ?? request.doneMs ?? request.submitMs;
    events.push(
      request.error !== null
        ? {
            requestId: request.requestId,
            tMs: endMs,
            kind: "error",
            message: request.error,
          }
        : { requestId: request.requestId, tMs: endMs, kind: "done" },
    );
  }
  return events;
}

function describeRequestFailures(
  measured: readonly Pick<MeasuredRequest, "error">[],
): { count: number; message: string } | null {
  const failedMessages = measured.flatMap((request) =>
    request.error !== null && request.error !== CANCELED_REQUEST_ERROR
      ? [request.error]
      : [],
  );
  if (failedMessages.length === 0) return null;
  const distinct = [...new Set(failedMessages)];
  return {
    count: failedMessages.length,
    message: `${failedMessages.length} of ${measured.length} requests failed: ${distinct.join("; ")}`,
  };
}

async function measurePlannedRequest(input: {
  context: ExecutionContext;
  planned: PlannedRequest;
  repetition: number;
  model: string | null;
  now: () => number;
  sequence: number;
  signal: AbortSignal;
}): Promise<MeasuredRequest> {
  const { context, planned } = input;
  const requestId = `${input.repetition}:${input.sequence}:${planned.prompt.id}`;
  const metricsBefore = context.serverMetrics
    ? await context.serverMetrics.captureBefore()
    : null;
  const outcome = await runMeasuredRequest({
    url: `${context.baseUrl}/v1/chat/completions`,
    body: chatRequestBody({
      prompt: planned.prompt,
      scenario: context.scenario,
      model: input.model,
      maxTokens: context.scenario.maxTokensOverride ?? planned.prompt.maxTokens,
    }),
    signal: input.signal,
    timeoutMs: context.scenario.requestTimeoutMs,
    fetchImpl: context.fetchImpl,
    now: input.now,
  });
  let serverTimings = outcome.serverTimings;
  if (
    serverTimings === null &&
    context.serverMetrics &&
    outcome.error === null &&
    outcome.firstTokenMs !== null
  ) {
    serverTimings = await context.serverMetrics.requestTimings(metricsBefore);
  }
  return {
    requestId,
    promptId: planned.prompt.id,
    topic: planned.prompt.topic,
    language: planned.prompt.language,
    repetition: input.repetition,
    submitMs: outcome.submitMs,
    firstTokenMs: outcome.firstTokenMs,
    doneMs: outcome.doneMs,
    endedMs: outcome.endedMs,
    timedOut: outcome.timedOut,
    chunkTimesMs: outcome.chunkTimesMs,
    promptTokens: outcome.promptTokens,
    completionTokens: outcome.completionTokens,
    serverTimings,
    finishReason: outcome.finishReason,
    error: outcome.error,
  };
}

async function executeBenchmarkRun(context: ExecutionContext): Promise<void> {
  const { runId, scenario, wave } = context;
  const nativeLlamaApi =
    engineDescriptor(context.instance.kind).nativeApi === "llama";
  const warnings: string[] = [];
  const measured: MeasuredRequest[] = [];
  const load =
    scenario.mode === "sustained" ? new BenchmarkLoadCollector() : null;
  let eventWriter: Awaited<
    ReturnType<typeof createBenchmarkEventWriter>
  > | null = null;
  const totalRequests =
    scenario.mode === "sustained"
      ? (scenario.totalRequests ?? 0)
      : wave.length * scenario.repetitions;
  let completedRequests = 0;
  let activeRequests = 0;
  try {
    setProgress(runId, {
      phase: "prepare",
      completedRequests,
      totalRequests,
      activeRequests,
      repetition: 0,
    });
    const model = await resolveEndpointModel(context);
    const props = nativeLlamaApi ? await fetchServerProps(context) : null;
    const launch = context.launchSnapshot;
    const snapshot: BenchmarkTargetSnapshot = {
      instanceName: context.instance.name,
      engineKind: context.instance.kind,
      baseUrl: context.baseUrl,
      model,
      binaryPath: context.instance.binaryPath || null,
      args: context.runtimeArgs,
      env: launch ? launch.env : context.instance.env,
      numa: launch ? launch.numa : (context.instance.numa ?? null),
      rpcWorkers: launch ? launch.rpcWorkers : context.instance.rpcWorkers,
      launchCliArgs: launch ? launch.cliArgs : null,
      buildInfo: props?.buildInfo ?? null,
    };
    patchBenchmarkRun(runId, { snapshot });
    if (launch && hasLaunchSnapshotDrift(context.instance, launch)) {
      warnings.push(
        "instance config drifted from the running process; the snapshot records the launched configuration",
      );
    }

    const concurrency = scenario.mode === "sequential" ? 1 : wave.length;
    if (nativeLlamaApi) {
      const totalSlots = props?.totalSlots ?? null;
      if (totalSlots === null) {
        warnings.push("slot capacity unknown (GET /props failed)");
      } else if (concurrency > totalSlots) {
        warnings.push(
          scenario.mode === "sustained"
            ? `concurrency ${concurrency} exceeds ${totalSlots} server slots; time-to-first-token includes server queueing`
            : `concurrency ${concurrency} exceeds ${totalSlots} server slots; queueing will distort time-to-first-token`,
        );
      }
    } else if (concurrency > 1) {
      warnings.push(
        `slot capacity not verified for engine ${context.instance.kind}`,
      );
    }

    const firstPlanned = wave[0];
    if (scenario.warmup && firstPlanned) {
      setProgress(runId, {
        phase: "warmup",
        completedRequests,
        totalRequests,
        activeRequests,
        repetition: 0,
      });
      const warmupMetricsBefore = context.serverMetrics
        ? await context.serverMetrics.captureBefore()
        : null;
      const warmup = await runMeasuredRequest({
        url: `${context.baseUrl}/v1/chat/completions`,
        body: chatRequestBody({
          prompt: firstPlanned.prompt,
          scenario,
          model,
          maxTokens: WARMUP_MAX_TOKENS,
        }),
        signal: context.signal,
        timeoutMs: scenario.requestTimeoutMs,
        fetchImpl: context.fetchImpl,
      });
      if (warmup.error !== null && !context.signal.aborted) {
        throw new Error(`warmup request failed: ${warmup.error}`);
      }
      if (context.serverMetrics) {
        await context.serverMetrics.requestTimings(warmupMetricsBefore);
      }
    }

    if (load) eventWriter = await createBenchmarkEventWriter(runId);
    const epoch = performance.now();
    const now = () => performance.now() - epoch;
    await runBenchmarkSchedule({
      scenario,
      clients: wave.length,
      signal: context.signal,
      run: async ({ client, repetition, sequence, signal }) => {
        const planned = wave[client];
        if (!planned)
          throw new Error(`benchmark client ${client} has no prompt`);
        activeRequests += 1;
        setProgress(runId, {
          phase: "measure",
          completedRequests,
          totalRequests,
          activeRequests,
          repetition,
        });
        try {
          const request = await measurePlannedRequest({
            context,
            planned,
            repetition,
            model,
            now,
            sequence,
            signal,
          });
          if (load && eventWriter) {
            load.record(request);
            await eventWriter.append(benchmarkStreamEvents([request]));
          } else {
            measured.push(request);
          }
        } finally {
          activeRequests -= 1;
          completedRequests += 1;
          setProgress(runId, {
            phase: "measure",
            completedRequests,
            totalRequests,
            activeRequests,
            repetition,
          });
        }
      },
    });
    await eventWriter?.close();

    setProgress(runId, {
      phase: "finalize",
      completedRequests,
      totalRequests,
      activeRequests,
      repetition: scenario.repetitions - 1,
    });
    const { result, summary } = load
      ? load.analyze()
      : analyzeBenchmarkRun(measured);
    const requests = load?.requests ?? measured;
    const failures = describeRequestFailures(requests);
    if (failures) {
      warnings.push(failures.message);
    }
    const allFailed = failures !== null && failures.count === requests.length;
    if (load) writeBenchmarkRunResult(runId, result);
    else
      writeBenchmarkRunArtifacts(
        runId,
        benchmarkStreamEvents(measured),
        result,
      );
    patchBenchmarkRun(runId, {
      status: context.signal.aborted
        ? "canceled"
        : allFailed
          ? "failed"
          : "succeeded",
      finishedAt: nowIso(),
      warnings,
      summary,
      error: allFailed && !context.signal.aborted ? failures.message : null,
    });
    persistRunRecord(runId);
  } catch (error) {
    const message = (error as Error).message;
    logger.warn({ runId, error: message }, "benchmark run failed");
    let summary: BenchmarkRunSummary | null = null;
    if ((load?.requests.length ?? measured.length) > 0) {
      const analysis = load ? load.analyze() : analyzeBenchmarkRun(measured);
      summary = analysis.summary;
      try {
        if (load) writeBenchmarkRunResult(runId, analysis.result);
        else
          writeBenchmarkRunArtifacts(
            runId,
            benchmarkStreamEvents(measured),
            analysis.result,
          );
      } catch (artifactError) {
        logger.warn(
          { runId, error: (artifactError as Error).message },
          "benchmark partial artifacts could not be saved",
        );
      }
    }
    patchBenchmarkRun(runId, {
      ...(summary ? { summary } : {}),
      status: context.signal.aborted ? "canceled" : "failed",
      finishedAt: nowIso(),
      warnings,
      error: message,
    });
    if (summary) {
      persistRunRecord(runId);
    }
  } finally {
    try {
      await eventWriter?.close();
    } catch (error) {
      logger.warn(
        { runId, error: (error as Error).message },
        "benchmark events could not be closed",
      );
    }
    activeProgress.delete(runId);
  }
}

export function startBenchmarkRun(
  scenario: BenchmarkScenario,
  options: BenchmarkRunnerOptions = {},
): BenchmarkRun {
  const active = getActiveJob(BENCHMARK_JOB_DOMAIN);
  if (active) {
    throw new BenchmarkConflictError(
      `a benchmark run is already active: ${active.jobId}`,
    );
  }
  const wave = planWave(scenario);
  const instance = getInstance(scenario.target.instanceName);
  if (!instance) {
    throw new BenchmarkNotFoundError(
      `instance ${scenario.target.instanceName} not found`,
    );
  }
  const latestRun = latestProcessRun(instance.name);
  const runtime = runtimeEndpointInstance(instance, latestRun);
  const baseUrl = instanceBaseUrl(runtime);
  if (!baseUrl) {
    throw new Error(
      `instance ${instance.name} has no HTTP endpoint (UNIX sockets are not supported)`,
    );
  }
  const run = createBenchmarkRun({ id: newId(), scenario });
  const controller = new AbortController();
  const fetchImpl = options.fetchImpl ?? fetch;
  const soloRequests = scenario.mode === "sequential" || wave.length <= 1;
  const serverMetrics = soloRequests
    ? benchmarkServerMetricsSource(
        engineDescriptor(instance.kind).benchmarkServerMetrics,
        { baseUrl, fetchImpl, signal: controller.signal },
      )
    : null;
  const completion = executeBenchmarkRun({
    runId: run.id,
    scenario,
    wave,
    instance,
    runtimeArgs: runtime.args,
    launchSnapshot: activeLaunchSnapshot(instance.name, latestRun),
    baseUrl,
    signal: controller.signal,
    fetchImpl,
    serverMetrics,
  });
  registerActiveJob({
    domain: BENCHMARK_JOB_DOMAIN,
    jobId: run.id,
    cancel: () => controller.abort(),
    completion,
  });
  return run;
}

export function cancelBenchmarkRun(id: string): boolean {
  const active = getActiveJob(BENCHMARK_JOB_DOMAIN);
  if (!active || active.jobId !== id) {
    return false;
  }
  active.cancel();
  return true;
}

export async function waitForBenchmarkRun(
  id: string,
  timeoutMs: number,
): Promise<void> {
  const active = getActiveJob(BENCHMARK_JOB_DOMAIN);
  if (!active || active.jobId !== id) return;
  await new Promise<void>((resolveWait) => {
    const timer = setTimeout(resolveWait, timeoutMs);
    void active.completion
      .catch(() => undefined)
      .finally(() => {
        clearTimeout(timer);
        resolveWait();
      });
  });
}
