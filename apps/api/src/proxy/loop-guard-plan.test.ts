import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ApiProxyLoopGuardConfigSchema } from "@arriero/core";

import { createProxyTrace } from "./protocol-trace.js";
import { readApiProxyRequestFile } from "./request-files.js";
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

const openAiOperation = {
  protocol: "openai" as const,
  endpoint: "chat.completions",
  routePath: "/v1/chat/completions",
  transport: "http-json" as const,
};

const anthropicOperation = {
  protocol: "anthropic" as const,
  endpoint: "messages",
  routePath: "/proxy/anthropic/v1/messages",
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

function guardConfig(overrides: Record<string, unknown> = {}) {
  return ApiProxyLoopGuardConfigSchema.parse(overrides);
}

function openAiChunk(content: string): string {
  return `data: ${JSON.stringify({
    id: "chatcmpl-1",
    object: "chat.completion.chunk",
    created: 1,
    model: "m",
    choices: [{ index: 0, delta: { content }, finish_reason: null }],
  })}\n\n`;
}

function sourceFromFrames(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

const loopFrames = Array.from({ length: 400 }, () =>
  openAiChunk("---Запуск.\n\n"),
);

test("observe mode passes the stream through and records a trigger artifact", async () => {
  const value = trace();
  const plan = createApiProxyResponsePlanExecutor({
    effects: [{ type: "loop-guard", nodeName: "Guard", config: guardConfig() }],
    putCache: () => {},
    trace: value,
    operation: openAiOperation,
  });
  assert.ok(plan);

  const forwarded = await readAll(
    plan.tap(sourceFromFrames(loopFrames), sseResponse),
  );
  plan.flush();

  assert.equal(forwarded, loopFrames.join(""));
  assert.equal(value.files.length, 1);
  const file = value.files[0];
  assert.ok(file);
  assert.equal(file.kind, "loop-guard-trigger");
  assert.equal(file.label, "Guard");
  const record = readApiProxyRequestFile(file.path);
  assert.ok(record);
  const data = record.data as {
    action: string;
    enforced: boolean;
    status: string;
    trigger: { signal: string; lane: string } | null;
    timeline: unknown[];
  };
  assert.equal(data.action, "observe");
  assert.equal(data.enforced, false);
  assert.equal(data.status, "triggered");
  assert.ok(data.trigger);
  assert.equal(data.trigger.lane, "answer");
  assert.ok(data.timeline.length > 0);
});

test("finish mode cuts the stream with marker and synthetic openai tail", async () => {
  const value = trace();
  let finished = 0;
  const cacheWrites: string[] = [];
  const plan = createApiProxyResponsePlanExecutor({
    effects: [
      { type: "cache-store", key: "loop-key", ttlSeconds: 600 },
      {
        type: "loop-guard",
        nodeName: null,
        config: guardConfig({ action: "finish", markerText: "остановлено" }),
      },
    ],
    putCache: (input) => cacheWrites.push(input.key),
    trace: value,
    operation: openAiOperation,
    onEarlyFinish: () => {
      finished += 1;
    },
  });
  assert.ok(plan);

  const forwarded = await readAll(
    plan.tap(sourceFromFrames(loopFrames), sseResponse),
  );
  plan.flush();

  assert.equal(finished, 1);
  assert.ok(forwarded.length < loopFrames.join("").length);
  assert.ok(forwarded.includes("остановлено"));
  assert.ok(forwarded.includes('"finish_reason":"length"'));
  assert.ok(forwarded.trimEnd().endsWith("data: [DONE]"));
  assert.deepEqual(cacheWrites, []);
  assert.equal(value.files.length, 1);
  const record = readApiProxyRequestFile(value.files[0]!.path);
  assert.ok(record);
  assert.equal((record.data as { enforced: boolean }).enforced, true);
});

test("finish mode closes anthropic blocks and stops with max_tokens", async () => {
  const value = trace();
  const event = (type: string, payload: unknown) =>
    `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
  const frames = [
    event("message_start", {
      type: "message_start",
      message: { id: "msg_1", usage: { input_tokens: 1, output_tokens: 0 } },
    }),
    event("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "thinking", thinking: "" },
    }),
    ...Array.from({ length: 400 }, () =>
      event("content_block_delta", {
        type: "content_block_delta",
        index: 0,
        delta: { type: "thinking_delta", thinking: "Проверяю имя снова. " },
      }),
    ),
  ];
  const plan = createApiProxyResponsePlanExecutor({
    effects: [
      {
        type: "loop-guard",
        nodeName: null,
        config: guardConfig({ action: "finish" }),
      },
    ],
    putCache: () => {},
    trace: value,
    operation: anthropicOperation,
  });
  assert.ok(plan);

  const forwarded = await readAll(
    plan.tap(sourceFromFrames(frames), sseResponse),
  );
  plan.flush();

  assert.ok(forwarded.includes('"type":"content_block_stop","index":0'));
  assert.ok(forwarded.includes("обнаружено зацикливание"));
  assert.ok(forwarded.includes('"stop_reason":"max_tokens"'));
  assert.ok(forwarded.trimEnd().endsWith('data: {"type":"message_stop"}'));
  const record = readApiProxyRequestFile(value.files[0]!.path);
  assert.ok(record);
  const data = record.data as { trigger: { lane: string } | null };
  assert.equal(data.trigger?.lane, "reasoning");
});

test("non-stream body yields a near-miss artifact without body changes", () => {
  const fixture = readFileSync(
    new URL("./loop-guard-fixtures/template-cycle.txt", import.meta.url),
    "utf8",
  );
  const value = trace();
  const plan = createApiProxyResponsePlanExecutor({
    effects: [{ type: "loop-guard", nodeName: null, config: guardConfig() }],
    putCache: () => {},
    trace: value,
    operation: openAiOperation,
  });
  assert.ok(plan);

  const body = JSON.stringify({
    choices: [{ message: { content: fixture } }],
  });
  const delivered = plan.processText(body, jsonResponse);
  plan.flush();

  assert.equal(delivered, body);
  assert.equal(value.files.length, 1);
  assert.equal(value.files[0]!.kind, "loop-guard-near-miss");
});

test("a clean response records no artifacts", async () => {
  const value = trace();
  const plan = createApiProxyResponsePlanExecutor({
    effects: [
      {
        type: "loop-guard",
        nodeName: null,
        config: guardConfig({ action: "finish" }),
      },
    ],
    putCache: () => {},
    trace: value,
    operation: openAiOperation,
  });
  assert.ok(plan);

  const frames = Array.from({ length: 40 }, (_, index) =>
    openAiChunk(
      `осмысленный фрагмент ${index * 31} с разными числами ${index}; `,
    ),
  );
  const forwarded = await readAll(
    plan.tap(sourceFromFrames(frames), sseResponse),
  );
  plan.flush();

  assert.equal(forwarded, frames.join(""));
  assert.equal(value.files.length, 0);
});
