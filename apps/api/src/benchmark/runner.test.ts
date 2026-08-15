import { BenchmarkScenarioSchema, InstanceCreateSchema } from "@arriero/core";
import assert from "node:assert/strict";
import test from "node:test";

import { createInstance } from "../instances/repository.js";
import { getActiveJob } from "../jobs/registry.js";
import { createPathCatalogEntry } from "../path-catalog/repository.js";
import { createBenchmarkPrompt } from "./prompts.js";
import {
  deleteBenchmarkRun,
  getBenchmarkRun,
  readBenchmarkRunEvents,
  readBenchmarkRunRecord,
  readBenchmarkRunResult,
} from "./repository.js";
import {
  BENCHMARK_JOB_DOMAIN,
  cancelBenchmarkRun,
  startBenchmarkRun,
  waitForBenchmarkRun,
} from "./runner.js";

const INSTANCE_NAME = "bench-runner-test";
const PROMPT_ID = "runner-test-prompt";

let prepared = false;

function prepareFixtures(): void {
  if (prepared) return;
  prepared = true;
  const binary = createPathCatalogEntry({
    kind: "binary",
    name: "bench-runner-binary",
    path: "/usr/bin/true",
  });
  createInstance(
    InstanceCreateSchema.parse({
      name: INSTANCE_NAME,
      binaryPathRefId: binary.id,
      args: { "--host": "127.0.0.1", "--port": 18099 },
    }),
  );
  createBenchmarkPrompt({
    id: PROMPT_ID,
    title: "Runner test prompt",
    topic: "code",
    language: "en",
    prefillClass: "short",
    maxTokens: 256,
    messages: [{ role: "user", content: "count to ten" }],
  });
}

function sseResponse(frames: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(new TextEncoder().encode(frame));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function completionFrames(): string[] {
  return [
    'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
    'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
    'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"timings":{"prompt_n":5,"prompt_ms":10,"predicted_n":2,"predicted_ms":20}}\n\n',
    'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n',
    "data: [DONE]\n\n",
  ];
}

function errorFrames(): string[] {
  return [
    'data: {"error":{"message":"Context size has been exceeded."}}\n\n',
    "data: [DONE]\n\n",
  ];
}

function okFetchImpl(
  chatResponse: (call: number) => Response = () =>
    sseResponse(completionFrames()),
): typeof fetch {
  let chatCalls = 0;
  return async (input) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "test-model" }] });
    }
    if (url.endsWith("/props")) {
      return Response.json({ total_slots: 4 });
    }
    if (url.endsWith("/v1/chat/completions")) {
      chatCalls += 1;
      return chatResponse(chatCalls);
    }
    throw new Error(`unexpected url ${url}`);
  };
}

function scenario(overrides: Record<string, unknown> = {}) {
  return BenchmarkScenarioSchema.parse({
    target: { kind: "instance", instanceName: INSTANCE_NAME },
    mode: "parallel",
    composition: [{ promptId: PROMPT_ID, count: 2 }],
    ...overrides,
  });
}

async function awaitCompletion(): Promise<void> {
  await getActiveJob(BENCHMARK_JOB_DOMAIN)?.completion;
}

test("benchmark run measures a full parallel wave", async () => {
  prepareFixtures();
  const chatBodies: Array<Record<string, unknown>> = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "test-model" }] });
    }
    if (url.endsWith("/props")) {
      return Response.json({ total_slots: 4 });
    }
    if (url.endsWith("/v1/chat/completions")) {
      chatBodies.push(
        JSON.parse(String(init?.body)) as Record<string, unknown>,
      );
      return sseResponse(completionFrames());
    }
    throw new Error(`unexpected url ${url}`);
  };

  const run = startBenchmarkRun(scenario(), { fetchImpl });
  assert.equal(run.status, "running");
  await awaitCompletion();

  const finished = getBenchmarkRun(run.id);
  assert.equal(finished?.status, "succeeded");
  assert.equal(finished?.snapshot?.model, "test-model");
  assert.equal(finished?.snapshot?.engineKind, "llama-server");
  assert.equal(finished?.summary?.requestCount, 2);
  assert.equal(finished?.summary?.failedRequestCount, 0);
  assert.deepEqual(finished?.warnings, []);

  const result = readBenchmarkRunResult(run.id);
  assert.equal(result?.requests.length, 2);
  assert.ok(
    result?.requests.every((request) => request.serverTimings?.promptMs === 10),
  );
  const streamEvents = readBenchmarkRunEvents(run.id);
  assert.ok(streamEvents && streamEvents.length > 0);
  assert.ok(streamEvents.some((event) => event.kind === "done"));
  assert.deepEqual(readBenchmarkRunRecord(run.id), finished);

  assert.equal(chatBodies.length, 3);
  const warmupBody = chatBodies[0];
  assert.equal(warmupBody?.max_tokens, 32);
  for (const body of chatBodies.slice(1)) {
    assert.equal(body.model, "test-model");
    assert.equal(body.max_tokens, 256);
    assert.equal(body.stream, true);
    const messages = body.messages as Array<{ content: string }>;
    assert.ok(messages[0]?.content.startsWith("benchmark-nonce: "));
  }

  deleteBenchmarkRun(run.id);
});

test("benchmark run cancels in-flight requests", async () => {
  prepareFixtures();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "test-model" }] });
    }
    if (url.endsWith("/props")) {
      return Response.json({ total_slots: 4 });
    }
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"x"}}]}\n\n',
          ),
        );
        signal?.addEventListener("abort", () => {
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const run = startBenchmarkRun(scenario({ warmup: false }), { fetchImpl });
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  assert.equal(cancelBenchmarkRun(run.id), true);
  await awaitCompletion();

  const finished = getBenchmarkRun(run.id);
  assert.equal(finished?.status, "canceled");
  assert.deepEqual(finished?.warnings, []);
  const result = readBenchmarkRunResult(run.id);
  assert.equal(result?.requests.length, 2);
  assert.ok(result?.requests.every((request) => request.error === "canceled"));
  deleteBenchmarkRun(run.id);
});

test("benchmark run fails when every request fails", async () => {
  prepareFixtures();
  const fetchImpl = okFetchImpl(() => sseResponse(errorFrames()));

  const run = startBenchmarkRun(scenario({ warmup: false }), { fetchImpl });
  await awaitCompletion();

  const finished = getBenchmarkRun(run.id);
  assert.equal(finished?.status, "failed");
  assert.match(finished?.error ?? "", /2 of 2 requests failed/);
  assert.match(finished?.error ?? "", /Context size has been exceeded/);
  assert.equal(finished?.summary?.failedRequestCount, 2);
  assert.deepEqual(finished?.warnings, [finished?.error]);
  const record = readBenchmarkRunRecord(run.id);
  assert.equal(record?.status, "failed");
  assert.equal(record?.error, finished?.error);
  deleteBenchmarkRun(run.id);
});

test("partial request failures keep the run succeeded with a warning", async () => {
  prepareFixtures();
  const fetchImpl = okFetchImpl((call) =>
    sseResponse(call === 1 ? errorFrames() : completionFrames()),
  );

  const run = startBenchmarkRun(scenario({ warmup: false }), { fetchImpl });
  await awaitCompletion();

  const finished = getBenchmarkRun(run.id);
  assert.equal(finished?.status, "succeeded");
  assert.equal(finished?.error, null);
  assert.equal(finished?.summary?.failedRequestCount, 1);
  assert.ok(
    finished?.warnings.some((warning) =>
      /1 of 2 requests failed: upstream stream error: Context size has been exceeded\./.test(
        warning,
      ),
    ),
  );
  deleteBenchmarkRun(run.id);
});

test("waitForBenchmarkRun resolves when the run completes", async () => {
  prepareFixtures();
  const run = startBenchmarkRun(scenario({ warmup: false }), {
    fetchImpl: okFetchImpl(),
  });
  await waitForBenchmarkRun(run.id, 10_000);
  assert.notEqual(getBenchmarkRun(run.id)?.status, "running");
  await awaitCompletion();
  deleteBenchmarkRun(run.id);
});

test("only one benchmark run may be active", async () => {
  prepareFixtures();
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith("/v1/models")) {
      return Response.json({ data: [{ id: "test-model" }] });
    }
    if (url.endsWith("/props")) {
      return Response.json({ total_slots: 4 });
    }
    const signal = init?.signal;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        signal?.addEventListener("abort", () => {
          controller.error(new DOMException("aborted", "AbortError"));
        });
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };

  const run = startBenchmarkRun(scenario({ warmup: false }), { fetchImpl });
  assert.throws(() => startBenchmarkRun(scenario(), { fetchImpl }), {
    message: /already active/,
  });
  cancelBenchmarkRun(run.id);
  await awaitCompletion();
  deleteBenchmarkRun(run.id);
});

test("start rejects unknown prompt and unknown instance", () => {
  prepareFixtures();
  assert.throws(
    () =>
      startBenchmarkRun(
        scenario({ composition: [{ promptId: "missing", count: 1 }] }),
      ),
    { message: /prompt missing not found/ },
  );
  assert.throws(
    () =>
      startBenchmarkRun(
        BenchmarkScenarioSchema.parse({
          target: { kind: "instance", instanceName: "missing-instance" },
          mode: "sequential",
          composition: [{ promptId: PROMPT_ID, count: 1 }],
        }),
      ),
    { message: /instance missing-instance not found/ },
  );
});
