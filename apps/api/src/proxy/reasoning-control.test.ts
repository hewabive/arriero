import assert from "node:assert/strict";
import { test } from "node:test";

import {
  armApiProxyReasoningControl,
  endApiProxyUpstreamReasoning,
} from "./reasoning-control.js";

test("arms reasoning control without mutating the request body", () => {
  const body = { model: "m", stream: true };
  assert.deepEqual(armApiProxyReasoningControl(body), {
    model: "m",
    stream: true,
    reasoning_control: true,
  });
  assert.deepEqual(body, { model: "m", stream: true });
});

test("sends llama.cpp reasoning_end control with router model", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const result = await endApiProxyUpstreamReasoning({
    baseUrl: "http://127.0.0.1:8080/v1",
    authHeaders: { authorization: "Bearer secret" },
    completionId: "chatcmpl-1",
    model: "qwen",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    },
  });
  assert.deepEqual(result, { status: "ok", message: null });
  const request = requests[0];
  assert.ok(request);
  assert.equal(
    request.url,
    "http://127.0.0.1:8080/v1/chat/completions/control",
  );
  assert.deepEqual(JSON.parse(String(request.init.body)), {
    id: "chatcmpl-1",
    action: "reasoning_end",
    model: "qwen",
  });
  assert.equal(
    new Headers(request.init.headers).get("authorization"),
    "Bearer secret",
  );
});

test("surfaces a rejected reasoning control", async () => {
  const result = await endApiProxyUpstreamReasoning({
    baseUrl: "http://127.0.0.1:8080",
    authHeaders: {},
    completionId: "gone",
    model: null,
    fetchImpl: async () =>
      new Response(JSON.stringify({ success: false, message: "not found" }), {
        status: 200,
      }),
  });
  assert.deepEqual(result, { status: "failed", message: "not found" });
});
