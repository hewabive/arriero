import {
  engineDescriptor,
  type BenchmarkPromptWithSource,
  type BenchmarkRun,
  type BenchmarkRunPhase,
  type BenchmarkRunResult,
  type BenchmarkScenario,
  type BenchmarkSyntheticScenario,
} from "@arriero/core";

import { getInstance } from "../instances/repository.js";
import { getActiveJob, registerActiveJob } from "../jobs/registry.js";
import { hasLaunchSnapshotDrift } from "../process/launch-snapshot.js";
import { newId } from "../utils/id.js";
import { BenchmarkConflictError, BenchmarkNotFoundError } from "./errors.js";
import { runMeasuredRequest } from "./measure-client.js";
import { getBenchmarkPrompt } from "./prompts.js";
import {
  createBenchmarkEventWriter,
  createBenchmarkRun,
  patchBenchmarkRun,
  writeBenchmarkRunArtifacts,
  writeBenchmarkRunResult,
  type BenchmarkEventWriter,
} from "./repository.js";
import { loadReplayDataset } from "./replay-dataset.js";
import { executeReplayRun, type ReplayRunnerOptions } from "./replay-runner.js";
import {
  benchmarkEndpoint,
  benchmarkStreamEvents,
  benchmarkTargetSnapshot,
  clearBenchmarkRunProgress,
  closeBenchmarkEvents,
  describeRequestFailures,
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
} from "./run-support.js";
import { analyzeBenchmarkRun, type MeasuredRequest } from "./segmenter.js";
import { BenchmarkLoadCollector } from "./load-statistics.js";
import { runBenchmarkSchedule } from "./schedule.js";
import {
  benchmarkServerMetricsSource,
  type BenchmarkServerMetricsSource,
} from "./server-metrics.js";

export const BENCHMARK_JOB_DOMAIN = "benchmark";

export type BenchmarkRunnerOptions = {
  fetchImpl?: typeof fetch | undefined;
} & ReplayRunnerOptions;

type ExecutionContext = BenchmarkRunContext & {
  scenario: BenchmarkSyntheticScenario;
  wave: BenchmarkPromptWithSource[];
};

function planWave(
  scenario: BenchmarkSyntheticScenario,
): BenchmarkPromptWithSource[] {
  const wave: BenchmarkPromptWithSource[] = [];
  for (const entry of scenario.composition) {
    const prompt = getBenchmarkPrompt(entry.promptId);
    if (!prompt) {
      throw new BenchmarkNotFoundError(
        `benchmark prompt ${entry.promptId} not found`,
      );
    }
    for (let copy = 0; copy < entry.count; copy += 1) {
      wave.push(prompt);
    }
  }
  return wave;
}

function chatRequestBody(input: {
  prompt: BenchmarkPromptWithSource;
  scenario: BenchmarkSyntheticScenario;
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
  return {
    ...streamingRunFields(input.model, input.scenario.sampling),
    messages,
    max_tokens: input.maxTokens,
  };
}

async function measurePlannedRequest(input: {
  context: ExecutionContext;
  serverMetrics: BenchmarkServerMetricsSource | null;
  prompt: BenchmarkPromptWithSource;
  repetition: number;
  model: string | null;
  now: () => number;
  sequence: number;
  signal: AbortSignal;
}): Promise<MeasuredRequest> {
  const { context, prompt, serverMetrics } = input;
  const metricsBefore = serverMetrics
    ? await serverMetrics.captureBefore()
    : null;
  const outcome = await runMeasuredRequest({
    url: `${context.baseUrl}/v1/chat/completions`,
    body: chatRequestBody({
      prompt,
      scenario: context.scenario,
      model: input.model,
      maxTokens: context.scenario.maxTokensOverride ?? prompt.maxTokens,
    }),
    signal: input.signal,
    timeoutMs: context.scenario.requestTimeoutMs,
    fetchImpl: context.fetchImpl,
    now: input.now,
  });
  const serverTimings =
    outcome.serverTimings === null &&
    serverMetrics &&
    outcome.error === null &&
    outcome.firstTokenMs !== null
      ? await serverMetrics.requestTimings(metricsBefore)
      : outcome.serverTimings;
  return {
    requestId: `${input.repetition}:${input.sequence}:${prompt.id}`,
    promptId: prompt.id,
    topic: prompt.topic,
    language: prompt.language,
    repetition: input.repetition,
    ...outcome,
    serverTimings,
  };
}

function syntheticServerMetrics(
  context: ExecutionContext,
): BenchmarkServerMetricsSource | null {
  const soloRequests =
    context.scenario.mode === "sequential" || context.wave.length <= 1;
  return soloRequests
    ? benchmarkServerMetricsSource(
        engineDescriptor(context.instance.kind).benchmarkServerMetrics,
        context,
      )
    : null;
}

async function executeSyntheticRun(context: ExecutionContext): Promise<void> {
  const { runId, scenario, wave } = context;
  const nativeLlamaApi =
    engineDescriptor(context.instance.kind).nativeApi === "llama";
  const serverMetrics = syntheticServerMetrics(context);
  const warnings: string[] = [];
  const measured: MeasuredRequest[] = [];
  const load =
    scenario.mode === "sustained" ? new BenchmarkLoadCollector() : null;
  const analyze = () => (load ? load.analyze() : analyzeBenchmarkRun(measured));
  const save = (result: BenchmarkRunResult) =>
    load
      ? writeBenchmarkRunResult(runId, result)
      : writeBenchmarkRunArtifacts(
          runId,
          benchmarkStreamEvents(measured),
          result,
        );
  let eventWriter: BenchmarkEventWriter | null = null;
  const totalRequests =
    scenario.mode === "sustained"
      ? (scenario.totalRequests ?? 0)
      : wave.length * scenario.repetitions;
  let completedRequests = 0;
  let activeRequests = 0;
  const publishProgress = (phase: BenchmarkRunPhase, repetition: number) =>
    setBenchmarkRunProgress(runId, {
      phase,
      completedRequests,
      totalRequests,
      activeRequests,
      repetition,
    });
  try {
    publishProgress("prepare", 0);
    const model = await resolveEndpointModel(context);
    const props = nativeLlamaApi ? await fetchServerProps(context) : null;
    const launch = context.launch;
    patchBenchmarkRun(runId, {
      snapshot: benchmarkTargetSnapshot({
        instance: context.instance,
        runtimeArgs: context.runtimeArgs,
        launch,
        baseUrl: context.baseUrl,
        model,
        buildInfo: props?.buildInfo ?? null,
      }),
    });
    if (launch && hasLaunchSnapshotDrift(context.instance, launch)) {
      warnings.push(LAUNCH_DRIFT_WARNING);
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

    const firstPrompt = wave[0];
    if (scenario.warmup && firstPrompt) {
      publishProgress("warmup", 0);
      const warmupMetricsBefore = serverMetrics
        ? await serverMetrics.captureBefore()
        : null;
      const warmup = await runMeasuredRequest({
        url: `${context.baseUrl}/v1/chat/completions`,
        body: chatRequestBody({
          prompt: firstPrompt,
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
      if (serverMetrics) {
        await serverMetrics.requestTimings(warmupMetricsBefore);
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
        const prompt = wave[client];
        if (!prompt)
          throw new Error(`benchmark client ${client} has no prompt`);
        activeRequests += 1;
        publishProgress("measure", repetition);
        try {
          const request = await measurePlannedRequest({
            context,
            serverMetrics,
            prompt,
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
          publishProgress("measure", repetition);
        }
      },
    });
    await eventWriter?.close();

    publishProgress("finalize", scenario.repetitions - 1);
    const { result, summary } = analyze();
    const requests = load?.requests ?? measured;
    const failures = describeRequestFailures(requests);
    if (failures) {
      warnings.push(failures.message);
    }
    const allFailed = failures !== null && failures.count === requests.length;
    save(result);
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
    failBenchmarkRun({
      runId,
      error,
      canceled: context.signal.aborted,
      warnings,
      measuredCount: (load?.requests ?? measured).length,
      analyze,
      save,
    });
  } finally {
    await closeBenchmarkEvents(runId, eventWriter);
    clearBenchmarkRunProgress(runId);
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
  const execution =
    scenario.mode === "replay"
      ? {
          kind: "replay" as const,
          scenario,
          manifest: loadReplayDataset(scenario),
        }
      : { kind: "synthetic" as const, scenario, wave: planWave(scenario) };
  const instance = getInstance(scenario.target.instanceName);
  if (!instance) {
    throw new BenchmarkNotFoundError(
      `instance ${scenario.target.instanceName} not found`,
    );
  }
  const endpoint = benchmarkEndpoint(instance);
  if (!endpoint.baseUrl) {
    throw new Error(
      `instance ${instance.name} has no HTTP endpoint (UNIX sockets are not supported)`,
    );
  }
  const run = createBenchmarkRun({ id: newId(), scenario });
  const controller = new AbortController();
  const shared: BenchmarkRunContext = {
    ...endpoint,
    runId: run.id,
    instance,
    signal: controller.signal,
    fetchImpl: options.fetchImpl ?? fetch,
  };
  const completion =
    execution.kind === "replay"
      ? executeReplayRun({
          ...shared,
          scenario: execution.scenario,
          manifest: execution.manifest,
          options,
        })
      : executeSyntheticRun({
          ...shared,
          scenario: execution.scenario,
          wave: execution.wave,
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
