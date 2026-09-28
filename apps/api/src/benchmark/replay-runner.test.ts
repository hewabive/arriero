import assert from "node:assert/strict";
import test from "node:test";

import {
  BenchmarkScenarioSchema,
  InstanceCreateSchema,
  WORKLOAD_DATASET_FORMAT_VERSION,
  type BenchmarkReplayScenarioInput,
  type WorkloadDatasetContent,
  type WorkloadDatasetRecord,
  type WorkloadDatasetSegment,
} from "@arriero/core";

import { createInstance } from "../instances/repository.js";
import { getActiveJob } from "../jobs/registry.js";
import { createPathCatalogEntry } from "../path-catalog/repository.js";
import { apiProxyInstanceReservation } from "../proxy/run-reservation.js";
import { sseResponse } from "../test/sse-response.js";
import {
  decomposeWorkloadBody,
  workloadDatasetId,
} from "../workload/dataset-codec.js";
import { stageWorkloadDataset } from "../workload/dataset-store.js";
import { BenchmarkNotFoundError } from "./errors.js";
import {
  deleteBenchmarkRun,
  getBenchmarkRun,
  readBenchmarkRunResult,
} from "./repository.js";
import { getBenchmarkRunProgress } from "./run-support.js";
import {
  BENCHMARK_JOB_DOMAIN,
  cancelBenchmarkRun,
  startBenchmarkRun,
  type BenchmarkRunnerOptions,
} from "./runner.js";

const INSTANCE_NAME = "bench-replay-test";

let fixturesReady = false;

function prepareInstance(): void {
  if (fixturesReady) return;
  fixturesReady = true;
  const binary = createPathCatalogEntry({
    kind: "binary",
    name: "bench-replay-binary",
    path: "/usr/bin/true",
  });
  createInstance(
    InstanceCreateSchema.parse({
      name: INSTANCE_NAME,
      binaryPathRefId: binary.id,
      args: { "--host": "127.0.0.1", "--port": 18101 },
    }),
  );
}

type RecordSpec = {
  traceId: string;
  messages: number;
  offsetMs?: number;
  thinkTimeMs?: number | null;
  outcome?: "success" | "client-abort";
  promptTokens?: number | null;
  cacheReadTokens?: number | null;
  completionTokens?: number | null;
};

type SegmentSpec = {
  sessionId: string;
  priming?: RecordSpec;
  primingEndedAt?: string;
  records: RecordSpec[];
};

function history(sessionId: string, count: number): unknown[] {
  return Array.from({ length: count }, (_, index) =>
    index % 2 === 0
      ? { role: "user", content: `${sessionId} question ${index}` }
      : { role: "assistant", content: `${sessionId} answer ${index}` },
  );
}

async function freezeDataset(
  segments: SegmentSpec[],
  windows = 1,
): Promise<string> {
  const staging = await stageWorkloadDataset();
  const writes: Array<Promise<void>> = [];
  const record = (
    sessionId: string,
    spec: RecordSpec,
  ): WorkloadDatasetRecord => {
    const body = decomposeWorkloadBody(
      "openai",
      {
        model: "public-model",
        stream: true,
        max_tokens: 4096,
        temperature: 0.6,
        messages: [
          { role: "system", content: "You are a coding agent." },
          ...history(sessionId, spec.messages),
        ],
      },
      (hash, json) => {
        writes.push(staging.writeBlob(hash, json));
      },
    );
    assert.ok(body);
    return {
      traceId: spec.traceId,
      protocol: "openai",
      endpoint: "chat.completions",
      routePath: "/v1/chat/completions",
      offsetMs: spec.offsetMs ?? 0,
      thinkTimeMs: spec.thinkTimeMs ?? null,
      durationMs: 100,
      outcome: spec.outcome ?? "success",
      targetName: "local",
      promptTokens: spec.promptTokens ?? spec.messages * 10,
      cacheReadTokens: spec.cacheReadTokens ?? null,
      completionTokens: spec.completionTokens ?? 20,
      ttftMs: null,
      body,
    };
  };
  const datasetSegments: WorkloadDatasetSegment[] = segments.map((segment) => ({
    sessionId: segment.sessionId,
    windowIndex: 0,
    sourceName: "agent",
    modelId: "public-model",
    priming: segment.priming
      ? record(segment.sessionId, segment.priming)
      : null,
    primingEndedAt: segment.primingEndedAt ?? null,
    records: segment.records.map((spec) => record(segment.sessionId, spec)),
  }));
  const content: WorkloadDatasetContent = {
    formatVersion: WORKLOAD_DATASET_FORMAT_VERSION,
    normalizationVersion: 1,
    selection: {
      windows: Array.from({ length: windows }, (_, index) => ({
        from: `2026-09-2${index}T10:00:00.000Z`,
        to: `2026-09-2${index}T10:10:00.000Z`,
      })),
      sourceId: null,
      sourceName: "agent",
      modelId: "public-model",
      targetId: null,
      targetName: null,
    },
    segments: datasetSegments,
  };
  await Promise.all(writes);
  const id = workloadDatasetId(content);
  await staging.commit({
    id,
    meta: {
      name: `replay test ${id.slice(0, 8)}`,
      description: "",
      createdAt: new Date().toISOString(),
      arrieroVersion: null,
      population: null,
      profile: null,
      populationProfile: null,
      warnings: [],
    },
    content,
  });
  return id;
}

function completedStream(frames: unknown[]): Response {
  return sseResponse([
    ...frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`),
    "data: [DONE]\n\n",
  ]);
}

function completion(usage: {
  promptTokens: number;
  cachedTokens: number;
  completionTokens?: number;
}): Response {
  return completedStream([
    { choices: [{ delta: { reasoning_content: "thinking" } }] },
    {
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, function: { name: "read", arguments: "{}" } },
            ],
          },
        },
      ],
    },
    {
      choices: [{ delta: {}, finish_reason: "tool_calls" }],
      timings: { draft_n: 10, draft_n_accepted: 8 },
    },
    {
      choices: [],
      usage: {
        prompt_tokens: usage.promptTokens,
        completion_tokens: usage.completionTokens ?? 2,
        prompt_tokens_details: { cached_tokens: usage.cachedTokens },
      },
    },
  ]);
}

type ChatCall = {
  body: Record<string, unknown>;
  reservedBy: string | null;
};

type FakeEngine = {
  fetchImpl: typeof fetch;
  chats: ChatCall[];
  counted: number;
};

function fakeEngine(
  input: {
    contextTokens?: number;
    countTokens?: number;
    chat?: (
      body: Record<string, unknown>,
      call: number,
      signal: AbortSignal | null,
    ) => Promise<Response> | Response;
  } = {},
): FakeEngine {
  const engine: FakeEngine = { fetchImpl: fetch, chats: [], counted: 0 };
  engine.fetchImpl = async (url, init) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/models") {
      return Response.json({ data: [{ id: "test-model" }] });
    }
    if (path === "/props") {
      return Response.json({
        total_slots: 2,
        build_info: "b-replay",
        is_sleeping: false,
        default_generation_settings: { n_ctx: input.contextTokens ?? 32768 },
      });
    }
    if (path === "/v1/chat/completions/input_tokens") {
      engine.counted += 1;
      return Response.json({ input_tokens: input.countTokens ?? 200 });
    }
    if (path === "/v1/chat/completions") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      engine.chats.push({
        body,
        reservedBy: apiProxyInstanceReservation(INSTANCE_NAME)?.runId ?? null,
      });
      if (input.chat) {
        return input.chat(body, engine.chats.length, init?.signal ?? null);
      }
      const messages = body.messages as unknown[];
      return completion({
        promptTokens: messages.length * 10,
        cachedTokens: body.max_tokens === 1 ? 0 : messages.length * 5,
      });
    }
    throw new Error(`unexpected ${path}`);
  };
  return engine;
}

function replayScenario(
  datasetId: string,
  overrides: Partial<BenchmarkReplayScenarioInput> = {},
) {
  return BenchmarkScenarioSchema.parse({
    target: { kind: "instance", instanceName: INSTANCE_NAME },
    mode: "replay",
    datasetId,
    outputCeiling: 512,
    ...overrides,
  });
}

function runnerOptions(
  engine: FakeEngine,
  restarts: { count: number },
): BenchmarkRunnerOptions {
  return {
    fetchImpl: engine.fetchImpl,
    restartInstance: async () => {
      restarts.count += 1;
    },
    drainTimeoutMs: 1000,
    readyTimeoutMs: 1000,
  };
}

async function awaitCompletion(): Promise<void> {
  await getActiveJob(BENCHMARK_JOB_DOMAIN)?.completion;
}

function twoSessions(): SegmentSpec[] {
  return [
    {
      sessionId: "sess-a",
      priming: { traceId: "a0", messages: 3, promptTokens: 100 },
      primingEndedAt: "2026-09-20T09:59:00.000Z",
      records: [
        { traceId: "a1", messages: 5, cacheReadTokens: 90 },
        { traceId: "a2", messages: 7, thinkTimeMs: 30, cacheReadTokens: 60 },
      ],
    },
    {
      sessionId: "sess-b",
      records: [
        { traceId: "b1", messages: 1, offsetMs: 20 },
        {
          traceId: "b2",
          messages: 3,
          thinkTimeMs: 10,
          outcome: "client-abort",
          completionTokens: 7,
        },
      ],
    },
  ];
}

test("a replay run flushes, primes, measures every segment and releases the instance", async () => {
  prepareInstance();
  const datasetId = await freezeDataset(twoSessions());
  const engine = fakeEngine();
  const restarts = { count: 0 };
  const run = startBenchmarkRun(
    replayScenario(datasetId, { imitateClientAborts: true }),
    runnerOptions(engine, restarts),
  );
  await awaitCompletion();

  const finished = getBenchmarkRun(run.id);
  assert.equal(finished?.error, null);
  assert.equal(finished?.status, "succeeded");
  assert.equal(restarts.count, 1);
  const replay = finished?.snapshot?.replay;
  assert.ok(replay);
  assert.equal(replay.datasetId, datasetId);
  assert.match(replay.preparedBodyHash, /^[0-9a-f]{64}$/);
  assert.equal(replay.segmentCount, 2);
  assert.equal(replay.recordCount, 4);
  assert.equal(replay.primedSegmentCount, 1);
  assert.equal(replay.contextTokens, 32768);
  assert.deepEqual(replay.reservedInstances, [INSTANCE_NAME]);
  assert.equal(replay.flush?.method, "restart");
  assert.equal(replay.flush?.verification, "passed");
  assert.equal(finished?.snapshot?.buildInfo, "b-replay");
  assert.equal(engine.counted, 2);

  const [warmup, priming, ...measured] = engine.chats;
  assert.equal(warmup?.body.max_tokens, 32);
  assert.equal(priming?.body.max_tokens, 1);
  assert.equal((priming?.body.messages as unknown[]).length, 4);
  assert.equal(measured.length, 4);
  for (const call of measured) {
    assert.equal(call.reservedBy, run.id);
    assert.equal(call.body.model, "test-model");
    assert.equal(call.body.stream, true);
    assert.deepEqual(call.body.stream_options, { include_usage: true });
    assert.equal(call.body.temperature, 0.6);
  }
  const limits = new Map(
    measured.map((call) => [
      (call.body.messages as unknown[]).length,
      call.body.max_tokens,
    ]),
  );
  assert.equal(limits.get(6), 512);
  assert.equal(limits.get(4), 7);

  const summary = finished?.summary;
  assert.equal(summary?.requestCount, 4);
  assert.equal(summary?.acceptanceRate, 0.8);
  assert.equal(summary?.load?.successfulRequestCount, 4);
  const segments = summary?.replay?.segments ?? [];
  assert.deepEqual(
    segments.map((segment) => [
      segment.sessionId,
      segment.primed,
      segment.requestCount,
    ]),
    [
      ["sess-a", true, 2],
      ["sess-b", false, 2],
    ],
  );
  assert.equal(segments[0]?.promptTokens, 60 + 80);
  assert.equal(segments[0]?.cachedPromptTokens, 30 + 40);
  const fidelity = summary?.replay?.fidelity;
  assert.equal(fidelity?.comparedRequestCount, 2);
  assert.equal(fidelity?.uncomparedRequestCount, 2);
  assert.equal(readBenchmarkRunResult(run.id)?.fidelity?.length, 4);

  assert.equal(apiProxyInstanceReservation(INSTANCE_NAME), null);
  assert.equal(getBenchmarkRunProgress(run.id), null);
  deleteBenchmarkRun(run.id);
});

test("a cache that survived the flush fails the run at the first priming request", async () => {
  prepareInstance();
  const datasetId = await freezeDataset(twoSessions());
  const engine = fakeEngine({
    chat: (body) => {
      const messages = body.messages as unknown[];
      return completion({
        promptTokens: messages.length * 100,
        cachedTokens: messages.length * 90,
      });
    },
  });
  const run = startBenchmarkRun(
    replayScenario(datasetId, { warmup: false }),
    runnerOptions(engine, { count: 0 }),
  );
  await awaitCompletion();

  const finished = getBenchmarkRun(run.id);
  assert.equal(finished?.status, "failed");
  assert.match(finished?.error ?? "", /cache was not flushed/);
  assert.equal(finished?.snapshot?.replay?.flush?.verification, "failed");
  assert.equal(engine.chats.length, 1);
  assert.equal(apiProxyInstanceReservation(INSTANCE_NAME), null);
  deleteBenchmarkRun(run.id);
});

test("a dataset that overflows the context fails before the reservation", async () => {
  prepareInstance();
  const datasetId = await freezeDataset(twoSessions());
  const engine = fakeEngine({ contextTokens: 600, countTokens: 200 });
  const restarts = { count: 0 };
  const run = startBenchmarkRun(
    replayScenario(datasetId),
    runnerOptions(engine, restarts),
  );
  await awaitCompletion();

  const finished = getBenchmarkRun(run.id);
  assert.equal(finished?.status, "failed");
  assert.match(
    finished?.error ?? "",
    /2 segments do not fit the context of 600/,
  );
  assert.match(finished?.error ?? "", /sess-a .*sess-b/);
  assert.equal(restarts.count, 0);
  assert.equal(engine.chats.length, 0);
  assert.deepEqual(finished?.snapshot?.replay?.reservedInstances, []);
  deleteBenchmarkRun(run.id);
});

test("the first failed request fails the run and keeps what was measured", async () => {
  prepareInstance();
  const datasetId = await freezeDataset([
    {
      sessionId: "sess-c",
      records: [
        { traceId: "c1", messages: 1 },
        { traceId: "c2", messages: 3, thinkTimeMs: 0 },
        { traceId: "c3", messages: 5, thinkTimeMs: 0 },
      ],
    },
  ]);
  const engine = fakeEngine({
    chat: (body, call) =>
      call === 3
        ? new Response("boom", { status: 500 })
        : completion({
            promptTokens: (body.messages as unknown[]).length * 10,
            cachedTokens: 0,
          }),
  });
  const run = startBenchmarkRun(
    replayScenario(datasetId),
    runnerOptions(engine, { count: 0 }),
  );
  await awaitCompletion();

  const finished = getBenchmarkRun(run.id);
  assert.equal(finished?.status, "failed");
  assert.match(
    finished?.error ?? "",
    /request 2 of session sess-c \(trace c2\) failed: upstream 500/,
  );
  assert.equal(engine.chats.length, 3);
  assert.equal(finished?.summary?.requestCount, 2);
  assert.equal(finished?.summary?.failedRequestCount, 1);
  assert.equal(finished?.snapshot?.replay?.flush?.verification, "passed");
  assert.equal(readBenchmarkRunResult(run.id)?.requests.length, 2);
  assert.equal(apiProxyInstanceReservation(INSTANCE_NAME), null);
  deleteBenchmarkRun(run.id);
});

test("idle skipping replays an hour-long gap without waiting", async () => {
  prepareInstance();
  const datasetId = await freezeDataset([
    { sessionId: "sess-d", records: [{ traceId: "d1", messages: 1 }] },
    {
      sessionId: "sess-e",
      records: [{ traceId: "e1", messages: 1, offsetMs: 3_600_000 }],
    },
  ]);
  const engine = fakeEngine();
  const startedAt = Date.now();
  const run = startBenchmarkRun(
    replayScenario(datasetId, { warmup: false }),
    runnerOptions(engine, { count: 0 }),
  );
  await awaitCompletion();

  const finished = getBenchmarkRun(run.id);
  assert.equal(finished?.status, "succeeded");
  assert.ok(Date.now() - startedAt < 30_000);
  assert.equal(finished?.summary?.requestCount, 2);
  assert.ok((finished?.summary?.wallMs ?? Infinity) < 30_000);
  deleteBenchmarkRun(run.id);
});

test("canceling a replay run releases the reservation", async () => {
  prepareInstance();
  const datasetId = await freezeDataset([
    { sessionId: "sess-f", records: [{ traceId: "f1", messages: 1 }] },
  ]);
  let runId = "";
  const engine = fakeEngine({
    chat: (_body, _call, signal) =>
      new Promise<Response>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
        cancelBenchmarkRun(runId);
      }),
  });
  const run = startBenchmarkRun(
    replayScenario(datasetId, { warmup: false }),
    runnerOptions(engine, { count: 0 }),
  );
  runId = run.id;
  await awaitCompletion();

  const finished = getBenchmarkRun(run.id);
  assert.equal(finished?.status, "canceled");
  assert.equal(apiProxyInstanceReservation(INSTANCE_NAME), null);
  deleteBenchmarkRun(run.id);
});

test("priming follows the policy in the order of the sessions' last activity", async () => {
  prepareInstance();
  const segment = (
    sessionId: string,
    primingEndedAt: string,
    cacheReadTokens: number | null,
  ): SegmentSpec => ({
    sessionId,
    priming: { traceId: `${sessionId}-0`, messages: 1, promptTokens: 100 },
    primingEndedAt,
    records: [{ traceId: `${sessionId}-1`, messages: 3, cacheReadTokens }],
  });
  const datasetId = await freezeDataset([
    segment("hit", "2026-09-20T09:58:00.000Z", 80),
    segment("miss", "2026-09-20T09:50:00.000Z", 10),
    segment("unknown", "2026-09-20T09:55:00.000Z", null),
  ]);
  const primedSessions = async (priming: "recorded" | "all" | "none") => {
    const engine = fakeEngine();
    const run = startBenchmarkRun(
      replayScenario(datasetId, { priming, warmup: false }),
      runnerOptions(engine, { count: 0 }),
    );
    await awaitCompletion();
    const finished = getBenchmarkRun(run.id);
    assert.equal(finished?.status, "succeeded");
    deleteBenchmarkRun(run.id);
    return engine.chats
      .filter((call) => call.body.max_tokens === 1)
      .map((call) => {
        const messages = call.body.messages as Array<{ content: string }>;
        return messages[1]?.content.split(" ")[0];
      });
  };
  assert.deepEqual(await primedSessions("recorded"), ["unknown", "hit"]);
  assert.deepEqual(await primedSessions("all"), ["miss", "unknown", "hit"]);
  assert.deepEqual(await primedSessions("none"), []);
});

test("replay starts only on a verified dataset whose windows fit the plan", async () => {
  prepareInstance();
  assert.throws(
    () =>
      startBenchmarkRun(replayScenario("f".repeat(64)), {
        fetchImpl: fakeEngine().fetchImpl,
      }),
    BenchmarkNotFoundError,
  );
  const datasetId = await freezeDataset(
    [{ sessionId: "sess-g", records: [{ traceId: "g1", messages: 1 }] }],
    2,
  );
  assert.throws(
    () =>
      startBenchmarkRun(replayScenario(datasetId), {
        fetchImpl: fakeEngine().fetchImpl,
      }),
    /recorded arrival plan replays one window/,
  );
  assert.equal(getActiveJob(BENCHMARK_JOB_DOMAIN), null);
});
