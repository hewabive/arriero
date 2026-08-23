import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { StreamIdleTimeoutError, watchStreamIdle } from "./stream-idle.js";

const encoder = new TextEncoder();

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

test("watchStreamIdle passes the stream through untouched when disabled", async () => {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("hello"));
      controller.close();
    },
  });
  const watched = watchStreamIdle(source, null);
  assert.equal(watched, source);
});

test("watchStreamIdle forwards data and closes normally within the deadline", async () => {
  const source = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(encoder.encode("hel"));
      await delay(10);
      controller.enqueue(encoder.encode("lo"));
      controller.close();
    },
  });
  const out = await readAll(watchStreamIdle(source, 1_000));
  assert.equal(out, "hello");
});

test("watchStreamIdle errors the stream after upstream silence", async () => {
  let timedOut: StreamIdleTimeoutError | null = null;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("partial"));
    },
  });
  await assert.rejects(
    readAll(
      watchStreamIdle(source, 30, (error) => {
        timedOut = error;
      }),
    ),
    StreamIdleTimeoutError,
  );
  assert.notEqual(timedOut, null);
  assert.match(
    (timedOut as unknown as StreamIdleTimeoutError).message,
    /stalled/,
  );
});

test("watchStreamIdle re-arms the deadline on every chunk", async () => {
  const source = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (let i = 0; i < 4; i += 1) {
        controller.enqueue(encoder.encode("x"));
        await delay(25);
      }
      controller.close();
    },
  });
  const out = await readAll(watchStreamIdle(source, 60));
  assert.equal(out, "xxxx");
});

test("watchStreamIdle cancels the source when the consumer cancels", async () => {
  let cancelled: unknown = null;
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode("x"));
    },
    cancel(reason) {
      cancelled = reason;
    },
  });
  const watched = watchStreamIdle(source, 1_000);
  const reader = watched.getReader();
  await reader.read();
  await reader.cancel("client gone");
  assert.equal(cancelled, "client gone");
  await delay(5);
});
