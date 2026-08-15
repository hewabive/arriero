import type {
  BenchmarkPromptWithSource,
  BenchmarkRun,
  BenchmarkRunProgress,
  BenchmarkScenario,
  BenchmarkStreamEvent,
  BenchmarkTargetSnapshot,
  Instance,
} from "@arriero/core";

import { instanceBaseUrl } from "../instances/endpoint.js";
import { getInstance } from "../instances/repository.js";
import { getActiveJob, registerActiveJob } from "../jobs/registry.js";
import { logger } from "../logger.js";
import { runtimeEndpointInstance } from "../process/runtime-endpoint.js";
import { asObject, numberOrNull } from "../proxy/json.js";
import { newId } from "../utils/id.js";
import {
  CANCELED_REQUEST_ERROR,
  runMeasuredRequest,
} from "./measure-client.js";
import { getBenchmarkPrompt } from "./prompts.js";
import {
  createBenchmarkRun,
  getBenchmarkRun,
  patchBenchmarkRun,
  writeBenchmarkRunArtifacts,
  writeBenchmarkRunRecord,
} from "./repository.js";
import {
  buildBenchmarkRunResult,
  summarizeBenchmarkRunResult,
  type MeasuredRequest,
} from "./segmenter.js";

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
  index: number;
  prompt: BenchmarkPromptWithSource;
};

type ExecutionContext = {
  runId: string;
  scenario: BenchmarkScenario;
  instance: Instance;
  runtimeArgs: Instance["args"];
  baseUrl: string;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
};

function nowIso(): string {
  return new Date().toISOString();
}

function planWave(scenario: BenchmarkScenario): PlannedRequest[] {
  const wave: PlannedRequest[] = [];
  for (const entry of scenario.composition) {
    const prompt = getBenchmarkPrompt(entry.promptId);
    if (!prompt) {
      throw new Error(`benchmark prompt ${entry.promptId} not found`);
    }
    for (let copy = 0; copy < entry.count; copy += 1) {
      wave.push({ index: wave.length, prompt });
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

async function fetchTotalSlots(
  context: ExecutionContext,
): Promise<number | null> {
  try {
    const response = await context.fetchImpl(`${context.baseUrl}/props`, {
      signal: context.signal,
    });
    if (!response.ok) return null;
    const body = asObject(await response.json());
    return numberOrNull(body?.total_slots);
  } catch (error) {
    logger.debug(
      { baseUrl: context.baseUrl, error: (error as Error).message },
      "benchmark slot probe failed",
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

function describeRequestFailures(
  measured: readonly MeasuredRequest[],
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
  measured: MeasuredRequest[];
  events: BenchmarkStreamEvent[];
}): Promise<void> {
  const { context, planned } = input;
  const requestId = `${input.repetition}:${planned.index}:${planned.prompt.id}`;
  const outcome = await runMeasuredRequest({
    url: `${context.baseUrl}/v1/chat/completions`,
    body: chatRequestBody({
      prompt: planned.prompt,
      scenario: context.scenario,
      model: input.model,
      maxTokens: context.scenario.maxTokensOverride ?? planned.prompt.maxTokens,
    }),
    signal: context.signal,
    fetchImpl: context.fetchImpl,
    now: input.now,
  });
  input.measured.push({
    requestId,
    promptId: planned.prompt.id,
    topic: planned.prompt.topic,
    language: planned.prompt.language,
    repetition: input.repetition,
    submitMs: outcome.submitMs,
    firstTokenMs: outcome.firstTokenMs,
    doneMs: outcome.doneMs,
    chunkTimesMs: outcome.chunkTimesMs,
    promptTokens: outcome.promptTokens,
    completionTokens: outcome.completionTokens,
    serverTimings: outcome.serverTimings,
    finishReason: outcome.finishReason,
    error: outcome.error,
  });
  input.events.push({ requestId, tMs: outcome.submitMs, kind: "submit" });
  if (outcome.firstTokenMs !== null) {
    input.events.push({
      requestId,
      tMs: outcome.firstTokenMs,
      kind: "first-token",
    });
  }
  for (const chunkMs of outcome.chunkTimesMs) {
    input.events.push({ requestId, tMs: chunkMs, kind: "chunk" });
  }
  if (outcome.error !== null) {
    input.events.push({
      requestId,
      tMs: outcome.doneMs ?? outcome.submitMs,
      kind: "error",
      message: outcome.error,
    });
  } else {
    input.events.push({
      requestId,
      tMs: outcome.doneMs ?? outcome.submitMs,
      kind: "done",
    });
  }
}

async function executeBenchmarkRun(context: ExecutionContext): Promise<void> {
  const { runId, scenario } = context;
  const warnings: string[] = [];
  const measured: MeasuredRequest[] = [];
  const events: BenchmarkStreamEvent[] = [];
  const wave = planWave(scenario);
  const totalRequests = wave.length * scenario.repetitions;
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
    const snapshot: BenchmarkTargetSnapshot = {
      instanceName: context.instance.name,
      engineKind: context.instance.kind,
      baseUrl: context.baseUrl,
      model,
      binaryPath: context.instance.binaryPath || null,
      args: context.runtimeArgs,
    };
    patchBenchmarkRun(runId, { snapshot });

    const concurrency = scenario.mode === "parallel" ? wave.length : 1;
    if (context.instance.kind === "llama-server") {
      const totalSlots = await fetchTotalSlots(context);
      if (totalSlots === null) {
        warnings.push("slot capacity unknown (GET /props failed)");
      } else if (concurrency > totalSlots) {
        warnings.push(
          `concurrency ${concurrency} exceeds ${totalSlots} server slots; queueing will distort time-to-first-token`,
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
      const warmup = await runMeasuredRequest({
        url: `${context.baseUrl}/v1/chat/completions`,
        body: chatRequestBody({
          prompt: firstPlanned.prompt,
          scenario,
          model,
          maxTokens: WARMUP_MAX_TOKENS,
        }),
        signal: context.signal,
        fetchImpl: context.fetchImpl,
      });
      if (warmup.error !== null && !context.signal.aborted) {
        throw new Error(`warmup request failed: ${warmup.error}`);
      }
    }

    const epoch = performance.now();
    const now = () => performance.now() - epoch;
    for (
      let repetition = 0;
      repetition < scenario.repetitions && !context.signal.aborted;
      repetition += 1
    ) {
      const runOne = async (planned: PlannedRequest) => {
        activeRequests += 1;
        setProgress(runId, {
          phase: "measure",
          completedRequests,
          totalRequests,
          activeRequests,
          repetition,
        });
        try {
          await measurePlannedRequest({
            context,
            planned,
            repetition,
            model,
            now,
            measured,
            events,
          });
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
      };
      if (scenario.mode === "parallel") {
        await Promise.all(wave.map((planned) => runOne(planned)));
      } else {
        for (const planned of wave) {
          if (context.signal.aborted) break;
          await runOne(planned);
        }
      }
    }

    setProgress(runId, {
      phase: "finalize",
      completedRequests,
      totalRequests,
      activeRequests,
      repetition: scenario.repetitions - 1,
    });
    const result = buildBenchmarkRunResult(measured);
    const summary = summarizeBenchmarkRunResult(measured, result);
    const failures = describeRequestFailures(measured);
    if (failures) {
      warnings.push(failures.message);
    }
    const allFailed = failures !== null && failures.count === measured.length;
    writeBenchmarkRunArtifacts(runId, events, result);
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
    const hasMeasurements = measured.length > 0;
    if (hasMeasurements) {
      const result = buildBenchmarkRunResult(measured);
      writeBenchmarkRunArtifacts(runId, events, result);
      patchBenchmarkRun(runId, {
        summary: summarizeBenchmarkRunResult(measured, result),
      });
    }
    patchBenchmarkRun(runId, {
      status: context.signal.aborted ? "canceled" : "failed",
      finishedAt: nowIso(),
      warnings,
      error: message,
    });
    if (hasMeasurements) {
      persistRunRecord(runId);
    }
  } finally {
    activeProgress.delete(runId);
  }
}

export function startBenchmarkRun(
  scenario: BenchmarkScenario,
  options: BenchmarkRunnerOptions = {},
): BenchmarkRun {
  const active = getActiveJob(BENCHMARK_JOB_DOMAIN);
  if (active) {
    throw new Error(`a benchmark run is already active: ${active.jobId}`);
  }
  planWave(scenario);
  const instance = getInstance(scenario.target.instanceName);
  if (!instance) {
    throw new Error(`instance ${scenario.target.instanceName} not found`);
  }
  const runtime = runtimeEndpointInstance(instance);
  const baseUrl = instanceBaseUrl(runtime);
  if (!baseUrl) {
    throw new Error(
      `instance ${instance.name} has no HTTP endpoint (UNIX sockets are not supported)`,
    );
  }
  const run = createBenchmarkRun({ id: newId(), scenario });
  const controller = new AbortController();
  const completion = executeBenchmarkRun({
    runId: run.id,
    scenario,
    instance,
    runtimeArgs: runtime.args,
    baseUrl,
    signal: controller.signal,
    fetchImpl: options.fetchImpl ?? fetch,
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
