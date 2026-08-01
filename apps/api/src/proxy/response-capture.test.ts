import assert from "node:assert/strict";
import { test } from "node:test";

import { createProxyTrace } from "./protocol-trace.js";
import { readApiProxyRequestFile } from "./request-files.js";
import {
  clearApiProxyBroadcasts,
  registerApiProxyBroadcast,
  subscribeApiProxyBroadcast,
} from "./response-broadcast.js";
import { createApiProxyResponseCaptureSink } from "./response-capture.js";

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

test("response sink returns null when no captures are requested", () => {
  const sink = createApiProxyResponseCaptureSink({
    captures: [],
    cacheWrites: [],
    putCache: () => {},
    trace: trace(),
    operation,
  });
  assert.equal(sink, null);
});

test("response sink writes one capture-response file per target and is idempotent", () => {
  const value = trace();
  const sink = createApiProxyResponseCaptureSink({
    captures: [
      { type: "capture-response", nodeName: "Audit" },
      { type: "capture-response", nodeName: null },
    ],
    cacheWrites: [],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(sink);

  sink.setText(JSON.stringify({ choices: [{ message: { content: "hi" } }] }));
  sink.flush();
  sink.flush();

  assert.equal(value.files.length, 2);
  const [first, second] = value.files;
  assert.ok(first && second);
  assert.equal(first.kind, "capture-response");
  assert.equal(first.label, "Audit");
  assert.equal(second.label, null);

  const record = readApiProxyRequestFile(first.path);
  assert.ok(record);
  assert.deepEqual(record.data, {
    choices: [{ message: { content: "hi" } }],
  });
});

test("response sink writes nothing when no body was seen", () => {
  const value = trace();
  const sink = createApiProxyResponseCaptureSink({
    captures: [{ type: "capture-response", nodeName: null }],
    cacheWrites: [],
    putCache: () => {},
    trace: value,
    operation,
  });
  assert.ok(sink);
  sink.flush();
  assert.equal(value.files.length, 0);
});

test("response sink writes non-stream bodies to the cache and marks the trace", () => {
  const value = trace();
  const writes: Array<{ key: string; body: string; ttlSeconds: number }> = [];
  const sink = createApiProxyResponseCaptureSink({
    captures: [],
    cacheWrites: [{ type: "cache-store", key: "key-1", ttlSeconds: 600 }],
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

  sink.setText('{"object":"list","data":[]}');
  sink.flush();

  assert.deepEqual(writes, [
    { key: "key-1", body: '{"object":"list","data":[]}', ttlSeconds: 600 },
  ]);
  assert.equal(value.cache, "store");
});

test("response sink does not cache an error body or a streamed response", async () => {
  const value = trace();
  const writes: string[] = [];
  const sink = createApiProxyResponseCaptureSink({
    captures: [],
    cacheWrites: [
      { type: "cache-store", key: "key-err", ttlSeconds: 600 },
    ],
    putCache: (input) => writes.push(input.key),
    trace: value,
    operation,
  });
  assert.ok(sink);
  sink.setText('{"error":{"message":"nope"}}');
  sink.flush();
  assert.equal(writes.length, 0);
  assert.equal(value.cache, null);
});

test("a streaming owner stores SSE, feeds the broadcast, and finishes it", async () => {
  clearApiProxyBroadcasts();
  const value = trace();
  const writes: Array<{ isSse: boolean; contentType: string; body: string }> =
    [];
  registerApiProxyBroadcast("bkey");
  const subscriber = subscribeApiProxyBroadcast("bkey");
  assert.ok(subscriber);

  const sink = createApiProxyResponseCaptureSink({
    captures: [],
    cacheWrites: [{ type: "cache-store", key: "bkey", ttlSeconds: 600 }],
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
  const reader = sink.tap(source).getReader();
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

test("response sink streams through tapped chunks and captures the raw text", async () => {
  const value = trace();
  const sink = createApiProxyResponseCaptureSink({
    captures: [{ type: "capture-response", nodeName: null }],
    cacheWrites: [],
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

  const tapped = sink.tap(source);
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
