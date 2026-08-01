import assert from "node:assert/strict";
import { test } from "node:test";

import { createProxyTrace } from "./protocol-trace.js";
import { readApiProxyRequestFile } from "./request-files.js";
import {
  clearApiProxyBroadcasts,
  registerApiProxyBroadcast,
  subscribeApiProxyBroadcast,
} from "./response-broadcast.js";
import {
  findApiProxyInFlight,
  registerApiProxyInFlight,
} from "./response-coalesce.js";
import { createApiProxyResponsePlanExecutor } from "./response-plan.js";

function trace() {
  const value = createProxyTrace({
    protocol: "openai",
    endpoint: "chat.completions",
    routePath: "/v1/chat/completions",
    transport: "http-json",
  });
  value.modelId = "public-model";
  return value;
}

const operation = {
  protocol: "openai" as const,
  endpoint: "chat.completions",
  routePath: "/v1/chat/completions",
  transport: "http-json" as const,
};

const jsonResponse = {
  status: 200,
  contentType: "application/json",
  isSse: false,
};

const sseResponse = {
  status: 200,
  contentType: "text/event-stream",
  isSse: true,
};

test("response plan returns null when it has no effects", () => {
  const sink = createApiProxyResponsePlanExecutor({
    effects: [],
    putCache: () => {},
    trace: trace(),
    operation,
  });
  assert.equal(sink, null);
});

test("response plan unwinds captures in reverse order and is idempotent", () => {
  const value = trace();
  const sink = createApiProxyResponsePlanExecutor({
    effects: [
      { type: "capture-response", nodeName: "Audit" },
      { type: "capture-response", nodeName: null },
    ],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(sink);

  sink.processText(
    JSON.stringify({ choices: [{ message: { content: "hi" } }] }),
    jsonResponse,
  );
  sink.flush();
  sink.flush();

  assert.equal(value.files.length, 2);
  const [first, second] = value.files;
  assert.ok(first && second);
  assert.equal(first.kind, "capture-response");
  assert.equal(first.label, null);
  assert.equal(second.label, "Audit");

  const record = readApiProxyRequestFile(second.path);
  assert.ok(record);
  assert.deepEqual(record.data, {
    choices: [{ message: { content: "hi" } }],
  });
});

test("captures on either side of a response transform see positional bodies", () => {
  const value = trace();
  const plan = createApiProxyResponsePlanExecutor({
    effects: [
      { type: "capture-response", nodeName: "Before replace" },
      {
        type: "replace-response-text",
        rules: [{ enabled: true, find: "secret", replace: "[hidden]" }],
        includeReasoning: false,
        includeToolArguments: false,
      },
      { type: "capture-response", nodeName: "After replace" },
    ],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(plan);

  const delivered = plan.processText(
    JSON.stringify({
      choices: [{ message: { content: "the secret" } }],
    }),
    jsonResponse,
  );
  plan.flush();

  assert.deepEqual(JSON.parse(delivered), {
    choices: [{ message: { content: "the [hidden]" } }],
  });
  assert.deepEqual(
    value.files.map((file) => file.label),
    ["After replace", "Before replace"],
  );
  const raw = readApiProxyRequestFile(value.files[0]!.path);
  const transformed = readApiProxyRequestFile(value.files[1]!.path);
  assert.deepEqual(raw?.data, {
    choices: [{ message: { content: "the secret" } }],
  });
  assert.deepEqual(transformed?.data, {
    choices: [{ message: { content: "the [hidden]" } }],
  });
});

test("token scaling leaves the inner capture real and the outer capture client-visible", () => {
  const value = trace();
  value.usage = {
    promptTokens: 10_000,
    cacheReadTokens: null,
    cacheCreationTokens: null,
    completionTokens: 2_000,
    genMs: 1_000,
    ratePerSecond: 2_000,
    prefillMs: null,
    promptPerSecond: null,
  };
  const plan = createApiProxyResponsePlanExecutor({
    effects: [
      { type: "capture-response", nodeName: "Client-visible" },
      { type: "token-scale", factor: 10 },
      { type: "capture-response", nodeName: "Real target" },
    ],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(plan);
  const delivered = plan.processText(
    JSON.stringify({
      usage: { prompt_tokens: 10_000, completion_tokens: 2_000 },
    }),
    jsonResponse,
  );
  plan.flush();

  assert.deepEqual(JSON.parse(delivered), {
    usage: { prompt_tokens: 100_000, completion_tokens: 20_000 },
  });
  const real = readApiProxyRequestFile(value.files[0]!.path);
  const visible = readApiProxyRequestFile(value.files[1]!.path);
  assert.deepEqual(real?.data, {
    usage: { prompt_tokens: 10_000, completion_tokens: 2_000 },
  });
  assert.deepEqual(visible?.data, {
    usage: { prompt_tokens: 100_000, completion_tokens: 20_000 },
  });
  assert.equal(value.usage.promptTokens, 10_000);
  assert.equal(value.usage.completionTokens, 2_000);
  assert.equal(value.usage.ratePerSecond, 2_000);
});

test("response plan composes fusion branch effects after route effects", () => {
  const value = trace();
  const plan = createApiProxyResponsePlanExecutor({
    effects: [
      { type: "capture-response", nodeName: "Outer" },
      { type: "token-scale", factor: 10 },
    ],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(plan);
  const delivered = plan.processText(
    '{"usage":{"prompt_tokens":100,"completion_tokens":20}}',
    jsonResponse,
  );
  plan.flush();

  assert.deepEqual(JSON.parse(delivered), {
    usage: { prompt_tokens: 1_000, completion_tokens: 200 },
  });
  assert.deepEqual(readApiProxyRequestFile(value.files[0]!.path)?.data, {
    usage: { prompt_tokens: 1_000, completion_tokens: 200 },
  });
});

test("response plan writes nothing when no body was seen", () => {
  const value = trace();
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "capture-response", nodeName: null }],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(sink);
  sink.flush();
  assert.equal(value.files.length, 0);
});

test("response plan writes non-stream bodies to the cache and marks the trace", () => {
  const value = trace();
  const writes: Array<{ key: string; body: string; ttlSeconds: number }> = [];
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "cache-store", key: "key-1", ttlSeconds: 600 }],
    putCache: (input) =>
      writes.push({
        key: input.key,
        body: input.body,
        ttlSeconds: input.ttlSeconds,
      }),
    trace: value,
    operation,
  });
  assert.ok(sink);

  sink.processText('{"object":"list","data":[]}', jsonResponse);
  sink.flush();

  assert.deepEqual(writes, [
    { key: "key-1", body: '{"object":"list","data":[]}', ttlSeconds: 600 },
  ]);
  assert.equal(value.cache, "store");
});

test("cache stores the response visible at its position around a transform", () => {
  const writes = new Map<string, string>();
  const replacement = {
    type: "replace-response-text" as const,
    rules: [{ enabled: true, find: "secret", replace: "[hidden]" }],
    includeReasoning: false,
    includeToolArguments: false,
  };
  const raw = JSON.stringify({
    choices: [{ message: { content: "secret" } }],
  });
  for (const effects of [
    [
      { type: "cache-store" as const, key: "outer", ttlSeconds: 600 },
      replacement,
    ],
    [
      replacement,
      { type: "cache-store" as const, key: "inner", ttlSeconds: 600 },
    ],
  ]) {
    const plan = createApiProxyResponsePlanExecutor({
      effects,
      putCache: (input) => writes.set(input.key, input.body),
      trace: trace(),
      operation,
    });
    assert.ok(plan);
    plan.processText(raw, jsonResponse);
    plan.flush();
  }

  assert.equal(
    (
      JSON.parse(writes.get("outer") ?? "null") as {
        choices: Array<{ message: { content: string } }>;
      }
    ).choices[0]?.message.content,
    "[hidden]",
  );
  assert.equal(
    (
      JSON.parse(writes.get("inner") ?? "null") as {
        choices: Array<{ message: { content: string } }>;
      }
    ).choices[0]?.message.content,
    "secret",
  );
});

test("response plan does not cache an error body", async () => {
  const value = trace();
  const writes: string[] = [];
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "cache-store", key: "key-err", ttlSeconds: 600 }],
    putCache: (input) => writes.push(input.key),
    trace: value,
    operation,
  });
  assert.ok(sink);
  sink.processText('{"error":{"message":"nope"}}', jsonResponse);
  sink.flush();
  assert.equal(writes.length, 0);
  assert.equal(value.cache, null);
});

test("response plan skips captures and cache writes for failed responses", () => {
  const value = trace();
  const writes: string[] = [];
  const sink = createApiProxyResponsePlanExecutor({
    effects: [
      { type: "capture-response", nodeName: "Success only" },
      { type: "cache-store", key: "key-failed", ttlSeconds: 600 },
    ],
    putCache: (input) => writes.push(input.key),
    trace: value,
    operation,
  });
  assert.ok(sink);

  sink.processText('{"error":{"message":"nope"}}', {
    ...jsonResponse,
    status: 502,
  });
  sink.flush();

  assert.deepEqual(value.files, []);
  assert.deepEqual(writes, []);
});

test("a streaming owner stores SSE, feeds the broadcast, and finishes it", async () => {
  clearApiProxyBroadcasts();
  const value = trace();
  const writes: Array<{ isSse: boolean; contentType: string; body: string }> =
    [];
  registerApiProxyBroadcast("bkey");
  const subscriber = subscribeApiProxyBroadcast("bkey");
  assert.ok(subscriber);

  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "cache-store", key: "bkey", ttlSeconds: 600 }],
    putCache: (input) =>
      writes.push({
        isSse: input.isSse,
        contentType: input.contentType,
        body: input.body,
      }),
    trace: value,
    operation,
  });
  assert.ok(sink);

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode("data: a\n\n"));
      controller.enqueue(encoder.encode("data: b\n\n"));
      controller.close();
    },
  });
  const reader = sink.tap(source, sseResponse).getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) {
      break;
    }
  }
  sink.flush();

  assert.deepEqual(writes, [
    {
      isSse: true,
      contentType: "text/event-stream",
      body: "data: a\n\ndata: b\n\n",
    },
  ]);
  assert.equal(value.cache, "store");

  const decoder = new TextDecoder();
  let received = "";
  const subReader = subscriber.body.getReader();
  for (;;) {
    const { done, value: chunk } = await subReader.read();
    if (done) {
      break;
    }
    received += decoder.decode(chunk, { stream: true });
  }
  assert.equal(received, "data: a\n\ndata: b\n\n");
  assert.equal(subscribeApiProxyBroadcast("bkey"), null);
});

test("response plan streams through tapped chunks and captures the raw text", async () => {
  const value = trace();
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "capture-response", nodeName: null }],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(sink);

  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      controller.enqueue(encoder.encode("data: a\n\n"));
      controller.enqueue(encoder.encode("data: b\n\n"));
      controller.close();
    },
  });

  const tapped = sink.tap(source, sseResponse);
  const reader = tapped.getReader();
  const decoder = new TextDecoder();
  let forwarded = "";
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) {
      break;
    }
    forwarded += decoder.decode(chunk, { stream: true });
  }
  sink.flush();

  assert.equal(forwarded, "data: a\n\ndata: b\n\n");
  assert.equal(value.files.length, 1);
  const record = readApiProxyRequestFile(value.files[0]!.path);
  assert.ok(record);
  assert.equal(record.data, "data: a\n\ndata: b\n\n");
});

test("flushing a plan that saw no response settles in-flight and aborts the broadcast", async () => {
  clearApiProxyBroadcasts();
  registerApiProxyBroadcast("leak-key");
  registerApiProxyInFlight("leak-key");
  const subscriber = subscribeApiProxyBroadcast("leak-key");
  assert.ok(subscriber);
  const reader = subscriber.body.getReader();

  const value = trace();
  value.errorMessage = "fusion quorum not met";
  const writes: string[] = [];
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "cache-store", key: "leak-key", ttlSeconds: 600 }],
    putCache: (input) => writes.push(input.key),
    trace: value,
    operation,
  });
  assert.ok(sink);
  sink.flush();

  await assert.rejects(reader.read(), /fusion quorum not met/);
  assert.equal(findApiProxyInFlight("leak-key"), null);
  assert.equal(subscribeApiProxyBroadcast("leak-key"), null);
  assert.deepEqual(writes, []);
});

test("an upstream error final is not pushed to coalesced followers", async () => {
  clearApiProxyBroadcasts();
  registerApiProxyBroadcast("err-key");
  const subscriber = subscribeApiProxyBroadcast("err-key");
  assert.ok(subscriber);
  const reader = subscriber.body.getReader();

  const value = trace();
  value.errorMessage = "Proxy target llama failed to forward request: boom";
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "cache-store", key: "err-key", ttlSeconds: 600 }],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(sink);
  sink.processText('{"error":{"message":"boom"}}', {
    status: 502,
    contentType: "application/json",
    isSse: true,
  });
  sink.flush();

  await assert.rejects(reader.read(), /failed to forward request/);
});

test("a cache-served response keeps its hit marker when an upstream store flushes", () => {
  const value = trace();
  value.cache = "hit";
  const writes: string[] = [];
  const sink = createApiProxyResponsePlanExecutor({
    effects: [{ type: "cache-store", key: "upstream-key", ttlSeconds: 600 }],
    putCache: (input) => writes.push(input.key),
    trace: value,
    operation,
  });
  assert.ok(sink);
  sink.processText('{"object":"chat.completion"}', jsonResponse);
  sink.flush();

  assert.deepEqual(writes, ["upstream-key"]);
  assert.equal(value.cache, "hit");
});
