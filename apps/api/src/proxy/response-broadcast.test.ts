import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import {
  abortApiProxyBroadcast,
  clearApiProxyBroadcasts,
  finishApiProxyBroadcast,
  pushApiProxyBroadcast,
  registerApiProxyBroadcast,
  subscribeApiProxyBroadcast,
} from "./response-broadcast.js";

const enc = new TextEncoder();
const dec = new TextDecoder();

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    out += dec.decode(value, { stream: true });
  }
  return out;
}

beforeEach(() => {
  clearApiProxyBroadcasts();
});

test("subscribe returns null when nothing is broadcasting", () => {
  assert.equal(subscribeApiProxyBroadcast("k"), null);
});

test("a late subscriber replays the buffer then receives live chunks", async () => {
  registerApiProxyBroadcast("k");
  pushApiProxyBroadcast("k", enc.encode("a"));
  pushApiProxyBroadcast("k", enc.encode("b"));

  const sub = subscribeApiProxyBroadcast("k");
  assert.ok(sub);
  assert.equal(sub.contentType, "text/event-stream");
  const collected = readAll(sub.body);

  pushApiProxyBroadcast("k", enc.encode("c"));
  finishApiProxyBroadcast("k");

  assert.equal(await collected, "abc");
});

test("multiple subscribers each get the full stream", async () => {
  registerApiProxyBroadcast("k");
  const a = subscribeApiProxyBroadcast("k");
  const b = subscribeApiProxyBroadcast("k");
  assert.ok(a && b);
  const ra = readAll(a.body);
  const rb = readAll(b.body);
  pushApiProxyBroadcast("k", enc.encode("x"));
  pushApiProxyBroadcast("k", enc.encode("y"));
  finishApiProxyBroadcast("k");
  assert.equal(await ra, "xy");
  assert.equal(await rb, "xy");
});

test("subscribing after finish returns null", () => {
  registerApiProxyBroadcast("k");
  finishApiProxyBroadcast("k");
  assert.equal(subscribeApiProxyBroadcast("k"), null);
});

test("abort errors subscribers instead of closing them cleanly", async () => {
  registerApiProxyBroadcast("k");
  pushApiProxyBroadcast("k", enc.encode("partial"));
  const sub = subscribeApiProxyBroadcast("k");
  assert.ok(sub);
  const collected = readAll(sub.body);

  abortApiProxyBroadcast("k", "owner upstream failed");

  await assert.rejects(collected, /owner upstream failed/);
  assert.equal(subscribeApiProxyBroadcast("k"), null);
});
