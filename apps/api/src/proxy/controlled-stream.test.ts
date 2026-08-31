import assert from "node:assert/strict";
import { test } from "node:test";

import { createApiProxyFinishableSseStream } from "./controlled-stream.js";

function source(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk === undefined) {
        return;
      }
      controller.enqueue(encoder.encode(chunk));
    },
  });
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

test("finish emits a valid OpenAI terminal and discards a partial frame", async () => {
  const controller = new AbortController();
  const stream = createApiProxyFinishableSseStream({
    body: source([
      'data: {"id":"chatcmpl-1","model":"m","choices":[{"delta":{"content":"Hi"},"finish_reason":null}]}\n\n',
      'data: {"id":"chatcmpl-1","choices":[',
    ]),
    protocol: "openai",
    finishSignal: controller.signal,
  });
  const reader = stream.getReader();
  const first = await reader.read();
  assert.equal(new TextDecoder().decode(first.value).includes('"Hi"'), true);
  controller.abort();
  let rest = "";
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    rest += new TextDecoder().decode(result.value);
  }
  assert.equal(rest.includes('"finish_reason":"stop"'), true);
  assert.equal(rest.endsWith("data: [DONE]\n\n"), true);
  assert.equal(rest.includes('choices":[data:'), false);
});

test("finish closes Anthropic thinking before the message", async () => {
  const controller = new AbortController();
  const stream = createApiProxyFinishableSseStream({
    body: source([
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","model":"m"}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}\n\n',
    ]),
    protocol: "anthropic",
    finishSignal: controller.signal,
  });
  const reader = stream.getReader();
  await reader.read();
  await reader.read();
  controller.abort();
  let rest = "";
  for (;;) {
    const result = await reader.read();
    if (result.done) {
      break;
    }
    rest += new TextDecoder().decode(result.value);
  }
  assert.equal(rest.includes('"type":"signature_delta"'), true);
  assert.equal(rest.includes('"type":"content_block_stop"'), true);
  assert.equal(rest.includes('"type":"message_stop"'), true);
  assert.equal(
    rest.indexOf('"type":"content_block_stop"') <
      rest.indexOf('"type":"message_stop"'),
    true,
  );
});
