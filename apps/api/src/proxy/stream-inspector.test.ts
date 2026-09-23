import assert from "node:assert/strict";
import test from "node:test";

import { ApiProxyTraceUsageSchema } from "@arriero/core";
import { openAiResumableCodec } from "./openai.js";
import { traceUsageFromCounts } from "./protocol-trace.js";
import { createProxyStreamInspector } from "./stream-inspector.js";

function inspector(estimateRate = true) {
  let time = 0;
  const stream = createProxyStreamInspector({
    codec: openAiResumableCodec,
    estimateRate,
    now: () => time,
  });
  return {
    stream,
    push(at: number, data: unknown) {
      time = at;
      stream.observeData(
        typeof data === "string" ? data : JSON.stringify(data),
      );
    },
  };
}

function delta(value: Record<string, unknown>, finish: string | null = null) {
  return { choices: [{ delta: value, finish_reason: finish }] };
}

const usage = {
  choices: [],
  usage: { prompt_tokens: 120, completion_tokens: 40 },
};

test("observed generation time includes reasoning and tools but excludes startup and trailing usage delay", () => {
  const { stream, push } = inspector();
  push(0, delta({ role: "assistant", content: "" }));
  push(5_000, delta({ reasoning_content: "Thinking" }));
  push(5_500, delta({ content: "Answer" }));
  push(
    6_000,
    delta({
      tool_calls: [{ index: 0, function: { name: "read", arguments: "{" } }],
    }),
  );
  push(
    7_000,
    delta({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }),
  );
  push(8_000, delta({}, "tool_calls"));
  push(12_000, usage);
  push(13_000, "[DONE]");
  const result = stream.finish();
  assert.equal(result.genMs, 0);
  assert.equal(result.observedGenMs, 2_000);
  const trace = traceUsageFromCounts({
    ...result,
    prefillMs: null,
    promptPerSecond: null,
  });
  assert.equal(trace.genMs, 2_000);
  assert.equal(trace.ratePerSecond, 20);
  assert.equal(trace.rateSource, "proxy");
  assert.deepEqual(ApiProxyTraceUsageSchema.parse(trace), trace);
  push(20_000, delta({ content: "late output" }));
  assert.equal(stream.finish().observedGenMs, 2_000);
});

for (const output of [
  { content: "text" },
  { reasoning_content: "reasoning" },
  { tool_calls: [{ index: 0, function: { arguments: "{}" } }] },
]) {
  test(`estimates a stream containing only ${Object.keys(output)[0]}`, () => {
    const { stream, push } = inspector();
    push(0, delta(output));
    push(1_000, delta(output, "stop"));
    push(2_000, usage);
    assert.equal(stream.finish().observedGenMs, 1_000);
  });
}

for (const reason of [
  "disabled",
  "one chunk",
  "zero interval",
  "no usage",
  "one token",
  "no terminal",
  "malformed",
  "metadata only",
] as const) {
  test(`does not estimate with ${reason}`, () => {
    const { stream, push } = inspector(reason !== "disabled");
    const content =
      reason === "metadata only" ? { role: "assistant" } : { content: "Hello" };
    push(100, delta(content));
    if (reason !== "one chunk")
      push(reason === "zero interval" ? 100 : 1_100, delta(content));
    if (reason === "malformed") push(1_200, "{");
    if (reason !== "no terminal") push(2_000, delta({}, "stop"));
    if (reason !== "no usage")
      push(3_000, {
        ...usage,
        usage: {
          ...usage.usage,
          completion_tokens: reason === "one token" ? 1 : 40,
        },
      });
    assert.equal(stream.finish().observedGenMs, undefined);
  });
}

test("server timings take priority over an observed interval", () => {
  const { stream, push } = inspector();
  push(0, delta({ content: "Hello" }));
  push(1_000, delta({ content: "world" }, "stop"));
  push(4_000, { ...usage, timings: { predicted_ms: 500 } });
  const result = stream.finish();
  assert.equal(result.observedGenMs, undefined);
  const trace = traceUsageFromCounts({
    ...result,
    prefillMs: null,
    promptPerSecond: null,
  });
  assert.equal(trace.genMs, 500);
  assert.equal(trace.ratePerSecond, 80);
  assert.equal(trace.rateSource, undefined);
});
