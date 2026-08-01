import assert from "node:assert/strict";
import test from "node:test";

import {
  createApiProxySseFrameBuffer,
  createApiProxySseTransform,
  mutateApiProxyJsonText,
  mutateApiProxySseJsonFrame,
} from "./response-codec.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

async function transformText(
  chunks: string[],
  transform: TransformStream<Uint8Array, Uint8Array>,
): Promise<string> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
  const reader = source.pipeThrough(transform).getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

test("lossless SSE buffer preserves mixed terminators across chunk boundaries", () => {
  const frames = createApiProxySseFrameBuffer();
  assert.deepEqual(frames.push(encoder.encode("event: one\r")), []);
  assert.deepEqual(frames.push(encoder.encode("\ndata: 1\r\n\r")), []);
  assert.deepEqual(frames.push(encoder.encode("\ndata: 2\n\ntrail")), [
    "event: one\r\ndata: 1\r\n\r\n",
    "data: 2\n\n",
  ]);
  assert.equal(frames.flush(), "trail");
  assert.equal(frames.flush(), null);
});

test("JSON codec keeps the original bytes for no-op and invalid JSON", () => {
  const original = '{\n  "usage": { "input_tokens": 10 }\n}\n';
  assert.deepEqual(
    mutateApiProxyJsonText(original, (value) => ({ changed: false, value })),
    { changed: false, text: original },
  );
  assert.deepEqual(
    mutateApiProxyJsonText("not-json", () => ({
      changed: true,
      value: { changed: true },
    })),
    { changed: false, text: "not-json" },
  );
});

test("JSON codec serializes only a response that was actually changed", () => {
  const mutation = mutateApiProxyJsonText(
    '{ "usage": { "input_tokens": 10 } }',
    (value) => {
      const body = value as { usage: { input_tokens: number } };
      return {
        changed: true,
        value: {
          ...body,
          usage: { ...body.usage, input_tokens: 20 },
        },
      };
    },
  );
  assert.deepEqual(mutation, {
    changed: true,
    text: '{"usage":{"input_tokens":20}}',
  });
});

test("SSE JSON codec preserves comments, fields, spacing, terminators, and DONE", () => {
  const original =
    ': keepalive\r\nid: 7\r\nevent: message\r\ndata:   {"usage":{"output_tokens":2}}\r\nretry: 5000\r\n\r\n' +
    "data: [DONE]\n\n";
  const mutation = mutateApiProxySseJsonFrame(original, (value) => {
    const body = value as { usage?: { output_tokens?: number } };
    if (!body.usage?.output_tokens) {
      return { changed: false, value };
    }
    return {
      changed: true,
      value: {
        ...body,
        usage: {
          ...body.usage,
          output_tokens: body.usage.output_tokens * 10,
        },
      },
    };
  });
  assert.equal(
    mutation.text,
    ': keepalive\r\nid: 7\r\nevent: message\r\ndata:   {"usage":{"output_tokens":20}}\r\nretry: 5000\r\n\r\n' +
      "data: [DONE]\n\n",
  );
});

test("SSE transform is byte-stable when frame mutations are no-ops", async () => {
  const original =
    ': ping\r\ndata: {"delta":{"content":"hi"}}\r\n\r\n' +
    "data: [DONE]\n\n" +
    "unterminated tail";
  const output = await transformText(
    [original.slice(0, 9), original.slice(9, 31), original.slice(31)],
    createApiProxySseTransform({
      transform: (frame) =>
        mutateApiProxySseJsonFrame(frame, (value) => ({
          changed: false,
          value,
        })).text,
    }),
  );
  assert.equal(output, original);
});
