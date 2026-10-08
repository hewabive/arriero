import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiProxyInflightRegistry } from "./inflight.js";
import { responseToolCalls, trailingToolResultIds } from "./tool-calls.js";
import {
  markToolContinuation,
  recordNonStreamToolCalls,
} from "./tool-continuation.js";

test("trailing OpenAI tool messages continue a tool call, earlier ones do not", () => {
  const history = [
    { role: "user", content: "fix it" },
    { role: "assistant", tool_calls: [{ id: "call_a" }] },
    { role: "tool", tool_call_id: "call_a", content: "old" },
    { role: "assistant", tool_calls: [{ id: "call_b" }, { id: "call_c" }] },
    { role: "tool", tool_call_id: "call_b", content: "1" },
    { role: "tool", tool_call_id: "call_c", content: "2" },
  ];
  assert.deepEqual(
    trailingToolResultIds("openai-chat", { messages: history }),
    ["call_b", "call_c"],
  );
  assert.equal(
    trailingToolResultIds("openai-chat", {
      messages: [...history, { role: "user", content: "next" }],
    }),
    null,
  );
});

test("Anthropic tool_result blocks in the last user message continue a tool call", () => {
  const toolTurn = {
    role: "user",
    content: [
      { type: "tool_result", tool_use_id: "toolu_1", content: "ok" },
      { type: "text", text: "<system-reminder>" },
    ],
  };
  assert.deepEqual(
    trailingToolResultIds("anthropic", { messages: [toolTurn] }),
    ["toolu_1"],
  );
  assert.equal(
    trailingToolResultIds("anthropic", {
      messages: [toolTurn, { role: "assistant", content: "done" }],
    }),
    null,
  );
  assert.equal(
    trailingToolResultIds("anthropic", {
      messages: [{ role: "user", content: "plain" }],
    }),
    null,
  );
});

test("trailing Responses tool outputs continue a tool call", () => {
  assert.deepEqual(
    trailingToolResultIds("openai-responses", {
      input: [
        { type: "function_call", call_id: "call_1", name: "shell" },
        { type: "function_call_output", call_id: "call_1", output: "ok" },
        { type: "custom_tool_call_output", call_id: "call_2", output: "ok" },
      ],
    }),
    ["call_1", "call_2"],
  );
  assert.equal(
    trailingToolResultIds("openai-responses", { input: "plain text" }),
    null,
  );
});

test("non-stream responses yield their tool calls per protocol", () => {
  assert.deepEqual(
    responseToolCalls("openai-chat", {
      choices: [
        {
          message: {
            tool_calls: [
              { id: "call_1", function: { name: "bash", arguments: "{}" } },
            ],
          },
        },
      ],
    }),
    [{ index: 0, id: "call_1", name: "bash", arguments: "{}" }],
  );
  assert.deepEqual(
    responseToolCalls("anthropic", {
      content: [
        { type: "text", text: "Reading" },
        { type: "tool_use", id: "toolu_1", name: "Read", input: { p: "a" } },
      ],
    }),
    [{ index: 0, id: "toolu_1", name: "Read", arguments: '{"p":"a"}' }],
  );
  assert.deepEqual(
    responseToolCalls("openai-responses", {
      output: [
        { type: "web_search_call", id: "ws_1" },
        { type: "function_call", call_id: "call_9", name: "shell" },
      ],
    }),
    [{ index: 0, id: "call_9", name: "shell" }],
  );
  assert.equal(responseToolCalls("openai-chat", "not an object"), null);
});

test("only conversational operations mark continuations and record non-stream tool calls", () => {
  const registry = new ApiProxyInflightRegistry({ now: () => 0 });
  const messages = [{ role: "user", content: [{ type: "tool_result" }] }];
  const counting = registry.begin({ modelId: "m", protocol: "anthropic" });
  markToolContinuation(
    counting,
    { protocol: "anthropic", endpoint: "messages.count_tokens" },
    { messages },
  );
  assert.equal(counting.isContinuation(), false);
  const turn = registry.begin({ modelId: "m", protocol: "anthropic" });
  markToolContinuation(
    turn,
    { protocol: "anthropic", endpoint: "messages" },
    { messages },
  );
  assert.equal(turn.isContinuation(), true);

  const answer = registry.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "t",
  });
  answer.dispatched();
  recordNonStreamToolCalls(
    answer,
    { protocol: "openai", endpoint: "chat.completions" },
    JSON.stringify({
      choices: [{ message: { tool_calls: [{ id: "call_x" }] } }],
    }),
  );
  recordNonStreamToolCalls(
    answer,
    { protocol: "openai", endpoint: "embeddings" },
    JSON.stringify({
      choices: [{ message: { tool_calls: [{ id: "call_y" }] } }],
    }),
  );
  answer.end(true, 60_000);
  assert.deepEqual(
    registry.continuationHolds().map((hold) => hold.targetId),
    ["t"],
  );
  const next = registry.begin({ modelId: "m", protocol: "openai" });
  next.continueToolCalls(["call_y"]);
  assert.deepEqual(
    registry.continuationHolds().map((hold) => hold.targetId),
    ["t"],
  );
});
