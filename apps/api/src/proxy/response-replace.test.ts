import assert from "node:assert/strict";
import test from "node:test";

import type { ApiProxyReplaceResponseTextEffect } from "./pipeline.js";
import type { ApiProxyProtocolOperation } from "./protocol.js";
import {
  createApiProxyResponseReplaceStream,
  replaceApiProxyResponseSseText,
  replaceApiProxyResponseText,
} from "./response-replace.js";

const openAiChat: ApiProxyProtocolOperation = {
  protocol: "openai",
  endpoint: "chat.completions",
  routePath: "/v1/chat/completions",
  transport: "http-json",
};

const anthropicMessages: ApiProxyProtocolOperation = {
  protocol: "anthropic",
  endpoint: "messages",
  routePath: "/v1/messages",
  transport: "http-json",
};

const openAiResponses: ApiProxyProtocolOperation = {
  protocol: "openai",
  endpoint: "responses",
  routePath: "/v1/responses",
  transport: "http-json",
};

function effect(
  update: Partial<ApiProxyReplaceResponseTextEffect> = {},
): ApiProxyReplaceResponseTextEffect {
  return {
    type: "replace-response-text",
    rules: [{ enabled: true, find: "secret", replace: "[hidden]" }],
    includeReasoning: false,
    includeToolArguments: false,
    ...update,
  };
}

async function runStream(input: {
  operation: ApiProxyProtocolOperation;
  frames: string[];
  effect?: ApiProxyReplaceResponseTextEffect;
}): Promise<string> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of input.frames) {
        controller.enqueue(encoder.encode(frame));
      }
      controller.close();
    },
  });
  const reader = source
    .pipeThrough(
      createApiProxyResponseReplaceStream({
        operation: input.operation,
        effect: input.effect ?? effect(),
      }),
    )
    .getReader();
  let output = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    output += decoder.decode(value, { stream: true });
  }
  return output + decoder.decode();
}

function jsonData(output: string): Array<Record<string, unknown>> {
  return output
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((data) => data && data !== "[DONE]")
    .map((data) => JSON.parse(data) as Record<string, unknown>);
}

test("non-stream OpenAI replacement defaults to visible assistant text", () => {
  const source = {
    choices: [
      {
        message: {
          content: "visible secret",
          reasoning_content: "reasoning secret",
          tool_calls: [{ function: { arguments: '{"value":"secret"}' } }],
        },
      },
    ],
  };
  const result = replaceApiProxyResponseText({
    text: JSON.stringify(source),
    operation: openAiChat,
    effect: effect(),
  });
  assert.equal(result.count, 1);
  assert.deepEqual(JSON.parse(result.text), {
    choices: [
      {
        message: {
          content: "visible [hidden]",
          reasoning_content: "reasoning secret",
          tool_calls: [{ function: { arguments: '{"value":"secret"}' } }],
        },
      },
    ],
  });
});

test("non-stream replacement can opt into reasoning and tool arguments", () => {
  const result = replaceApiProxyResponseText({
    text: JSON.stringify({
      choices: [
        {
          message: {
            content: "secret",
            reasoning_content: "secret",
            tool_calls: [{ function: { arguments: "secret" } }],
          },
        },
      ],
    }),
    operation: openAiChat,
    effect: effect({ includeReasoning: true, includeToolArguments: true }),
  });
  assert.equal(result.count, 3);
});

test("non-stream replacement supports Anthropic and OpenAI Responses shapes", () => {
  const anthropic = replaceApiProxyResponseText({
    text: JSON.stringify({
      content: [
        { type: "text", text: "secret" },
        { type: "thinking", thinking: "secret" },
        { type: "tool_use", input: { value: "secret" } },
      ],
    }),
    operation: anthropicMessages,
    effect: effect({ includeReasoning: true, includeToolArguments: true }),
  });
  assert.equal(anthropic.count, 3);

  const responses = replaceApiProxyResponseText({
    text: JSON.stringify({
      output: [
        {
          type: "message",
          content: [{ type: "output_text", text: "secret" }],
        },
        {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "secret" }],
        },
        { type: "function_call", arguments: "secret" },
      ],
    }),
    operation: openAiResponses,
    effect: effect({ includeReasoning: true, includeToolArguments: true }),
  });
  assert.equal(responses.count, 3);
});

test("stream replacement matches literal text across OpenAI delta frames", async () => {
  const output = await runStream({
    operation: openAiChat,
    frames: [
      'data: {"choices":[{"index":0,"delta":{"content":"The sec"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{"content":"ret is safe"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ],
  });
  const text = jsonData(output)
    .map((body) => {
      const choices = body.choices as Array<{
        delta?: { content?: string };
      }>;
      return choices[0]?.delta?.content ?? "";
    })
    .join("");
  assert.equal(text, "The [hidden] is safe");
  assert.ok(output.endsWith("data: [DONE]\n\n"));
});

test("an ambiguous streaming prefix is flushed before the finish frame", async () => {
  const output = await runStream({
    operation: openAiChat,
    frames: [
      'data: {"choices":[{"index":0,"delta":{"content":"sec"}}]}\n\n',
      'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n',
      "data: [DONE]\n\n",
    ],
  });
  const bodies = jsonData(output);
  const content = bodies
    .map((body) => {
      const choices = body.choices as Array<{
        delta?: { content?: string };
        finish_reason?: string;
      }>;
      return choices[0]?.delta?.content ?? "";
    })
    .join("");
  assert.equal(content, "sec");
  const syntheticIndex = output.lastIndexOf('"content":"sec"');
  const finishIndex = output.indexOf('"finish_reason":"stop"');
  assert.ok(syntheticIndex >= 0 && syntheticIndex < finishIndex);
});

test("stream lanes stay independent and optional Anthropic surfaces are selectable", async () => {
  const output = await runStream({
    operation: anthropicMessages,
    effect: effect({ includeReasoning: true, includeToolArguments: true }),
    frames: [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"sec"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"secret"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":2,"delta":{"type":"input_json_delta","partial_json":"secret"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ret"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ],
  });
  const bodies = jsonData(output);
  const deltas = bodies
    .map((body) => body.delta)
    .filter((delta): delta is Record<string, unknown> =>
      Boolean(delta && typeof delta === "object"),
    );
  assert.equal(deltas.map((delta) => delta.text ?? "").join(""), "[hidden]");
  assert.equal(
    deltas.map((delta) => delta.thinking ?? "").join(""),
    "[hidden]",
  );
  assert.equal(
    deltas.map((delta) => delta.partial_json ?? "").join(""),
    "[hidden]",
  );
});

test("stream response is byte-stable when no rule can match", async () => {
  const original =
    ': ping\r\ndata: {"choices":[{"index":0,"delta":{"content":"hello"}}]}\r\n\r\n';
  const output = await runStream({ operation: openAiChat, frames: [original] });
  assert.equal(output, original);
});

test("a buffered SSE response uses the same cross-frame replacement", () => {
  const result = replaceApiProxyResponseSseText({
    text:
      'data: {"choices":[{"index":0,"delta":{"content":"sec"}}]}\n\n' +
      'data: {"choices":[{"index":0,"delta":{"content":"ret"}}]}\n\n' +
      "data: [DONE]\n\n",
    operation: openAiChat,
    effect: effect(),
  });
  const text = jsonData(result.text)
    .map((body) => {
      const choices = body.choices as Array<{
        delta?: { content?: string };
      }>;
      return choices[0]?.delta?.content ?? "";
    })
    .join("");
  assert.equal(text, "[hidden]");
  assert.equal(result.count, 1);
});
