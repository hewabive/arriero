import assert from "node:assert/strict";
import test from "node:test";

import { serializeAnthropicSseEvent } from "./sse.js";
import {
  createAnthropicSseEmitter,
  type AnthropicSseEmitter,
} from "./stream.js";
import type { AnthropicStreamEvent } from "./types.js";

function feed(
  emitter: AnthropicSseEmitter,
  chunks: unknown[],
): AnthropicStreamEvent[] {
  const events: AnthropicStreamEvent[] = [];
  for (const chunk of chunks) {
    const data = typeof chunk === "string" ? chunk : JSON.stringify(chunk);
    events.push(...emitter.push(data).events);
  }
  return events;
}

test("emits full Anthropic sequence for plain text stream", () => {
  const emitter = createAnthropicSseEmitter();
  const events = feed(emitter, [
    {
      id: "chatcmpl-1",
      model: "m",
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: "" },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    {
      choices: [],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 2,
        prompt_tokens_details: { cached_tokens: 4 },
      },
      timings: { predicted_ms: 100 },
    },
    "[DONE]",
  ]);

  assert.deepEqual(events, [
    {
      type: "message_start",
      message: {
        id: "msg_chatcmpl-1",
        type: "message",
        role: "assistant",
        model: "m",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "Hel" },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "lo" },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: {
        output_tokens: 2,
        input_tokens: 6,
        cache_read_input_tokens: 4,
      },
    },
    { type: "message_stop" },
  ]);
});

test("closes thinking block with signature_delta before text block", () => {
  const emitter = createAnthropicSseEmitter();
  const events = feed(emitter, [
    {
      id: "c",
      model: "m",
      choices: [
        {
          index: 0,
          delta: { reasoning_content: "think" },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        { index: 0, delta: { content: "answer" }, finish_reason: null },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ]);

  assert.deepEqual(
    events.map((event) =>
      event.type === "content_block_delta"
        ? `${event.type}:${event.index}:${event.delta.type}`
        : event.type === "content_block_start"
          ? `${event.type}:${event.index}:${event.content_block.type}`
          : event.type === "content_block_stop"
            ? `${event.type}:${event.index}`
            : event.type,
    ),
    [
      "message_start",
      "content_block_start:0:thinking",
      "content_block_delta:0:thinking_delta",
      "content_block_delta:0:signature_delta",
      "content_block_stop:0",
      "content_block_start:1:text",
      "content_block_delta:1:text_delta",
      "content_block_stop:1",
      "message_delta",
      "message_stop",
    ],
  );
});

test("streams tool call with input set to empty object on block start", () => {
  const emitter = createAnthropicSseEmitter();
  const events = feed(emitter, [
    {
      id: "c",
      model: "m",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_1",
                type: "function",
                function: { name: "lookup", arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '{"q":' } }],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: "1}" } }] },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]",
  ]);

  assert.deepEqual(events.slice(1, -2), [
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "call_1",
        name: "lookup",
        input: {},
      },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"q":1}' },
    },
    { type: "content_block_stop", index: 0 },
  ]);
  const messageDelta = events.at(-2);
  assert.equal(messageDelta?.type, "message_delta");
  assert.equal(
    messageDelta?.type === "message_delta"
      ? messageDelta.delta.stop_reason
      : null,
    "tool_use",
  );
});

test("opens separate blocks for parallel tool calls", () => {
  const emitter = createAnthropicSseEmitter();
  const events = feed(emitter, [
    {
      id: "c",
      model: "m",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                function: { name: "a", arguments: '{"x":1}' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 1,
                id: "call_b",
                function: { name: "b", arguments: "{}" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]",
  ]);

  const starts = events.filter((event) => event.type === "content_block_start");
  assert.equal(starts.length, 2);
  assert.deepEqual(
    starts.map((event) =>
      event.type === "content_block_start"
        ? { index: event.index, block: event.content_block }
        : null,
    ),
    [
      {
        index: 0,
        block: { type: "tool_use", id: "call_a", name: "a", input: {} },
      },
      {
        index: 1,
        block: { type: "tool_use", id: "call_b", name: "b", input: {} },
      },
    ],
  );
  assert.equal(
    events.filter((event) => event.type === "content_block_stop").length,
    2,
  );
});

test("buffers interleaved parallel tool deltas into valid sequential blocks", () => {
  const emitter = createAnthropicSseEmitter();
  const events = feed(emitter, [
    {
      id: "c",
      model: "m",
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: "call_a",
                function: { name: "a", arguments: '{"x":' },
              },
              {
                index: 1,
                id: "call_b",
                function: { name: "b", arguments: '{"y":' },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              { index: 1, function: { arguments: "2}" } },
              { index: 0, function: { arguments: "1}" } },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    "[DONE]",
  ]);

  const blocks = events.filter(
    (event) =>
      event.type === "content_block_start" ||
      event.type === "content_block_delta" ||
      event.type === "content_block_stop",
  );
  assert.deepEqual(blocks, [
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call_a", name: "a", input: {} },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"x":1}' },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "content_block_start",
      index: 1,
      content_block: { type: "tool_use", id: "call_b", name: "b", input: {} },
    },
    {
      type: "content_block_delta",
      index: 1,
      delta: { type: "input_json_delta", partial_json: '{"y":2}' },
    },
    { type: "content_block_stop", index: 1 },
  ]);
});

test("prompt_progress seeds message_start usage and later frames become pings", () => {
  const emitter = createAnthropicSseEmitter();

  const first = emitter.push(
    JSON.stringify({
      id: "c",
      model: "m",
      choices: [],
      prompt_progress: { total: 100, processed: 30, cache: 20 },
    }),
  );
  assert.deepEqual(first.extensions.promptProgress, {
    total: 100,
    processed: 30,
    cache: 20,
  });
  assert.equal(first.events.length, 1);
  const start = first.events[0];
  assert.equal(start?.type, "message_start");
  assert.deepEqual(
    start?.type === "message_start" ? start.message.usage : null,
    { input_tokens: 80, output_tokens: 0, cache_read_input_tokens: 20 },
  );

  const second = emitter.push(
    JSON.stringify({
      choices: [],
      prompt_progress: { total: 100, processed: 70, cache: 20 },
    }),
  );
  assert.deepEqual(second.events, [{ type: "ping" }]);

  const rest = feed(emitter, [
    { choices: [{ index: 0, delta: { content: "hi" }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    "[DONE]",
  ]);
  const messageDelta = rest.at(-2);
  assert.deepEqual(
    messageDelta?.type === "message_delta" ? messageDelta.usage : null,
    { output_tokens: 0, input_tokens: 80, cache_read_input_tokens: 20 },
  );
});

test("finish() closes open blocks after an aborted stream", () => {
  const emitter = createAnthropicSseEmitter();
  feed(emitter, [
    {
      id: "c",
      model: "m",
      choices: [{ index: 0, delta: { content: "par" }, finish_reason: null }],
    },
  ]);
  const events = emitter.finish();
  assert.deepEqual(
    events.map((event) => event.type),
    ["content_block_stop", "message_delta", "message_stop"],
  );
  assert.deepEqual(emitter.finish(), []);
});

test("maps upstream error frames to Anthropic error events", () => {
  const emitter = createAnthropicSseEmitter();
  const result = emitter.push(
    JSON.stringify({ error: { message: "boom", code: 500 } }),
  );
  assert.deepEqual(result.events, [
    { type: "error", error: { type: "api_error", message: "boom" } },
  ]);
});

test("serializes events with event name line", () => {
  assert.equal(
    serializeAnthropicSseEvent({ type: "message_stop" }),
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  );
});
