import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApiProxyStreamSessionRegistry,
  apiProxyStreamResumeKey,
  type ApiProxyStreamSessionInput,
} from "./stream-session.js";

function sessionInput(
  overrides: Partial<ApiProxyStreamSessionInput> = {},
): ApiProxyStreamSessionInput {
  return {
    inflightId: "req-1",
    instanceId: "instance-a",
    targetId: "target-a",
    modelId: "model-a",
    baseUrl: "http://127.0.0.1:8080/v1",
    authHeaders: { authorization: "Bearer test" },
    resumeKey: "key-1",
    protocol: "openai",
    endpoint: "chat.completions",
    stream: true,
    ...overrides,
  };
}

function captureRegistry() {
  const calls: { url: string; method: string | undefined }[] = [];
  const registry = new ApiProxyStreamSessionRegistry({
    fetchImpl: async (url, init) => {
      calls.push({ url, method: init.method });
      return new Response(null, { status: 200 });
    },
    now: () => "2026-07-02T00:00:00.000Z",
  });
  return { registry, calls };
}

test("register assigns a unique conv id per session", () => {
  const { registry } = captureRegistry();
  const first = registry.register(sessionInput({ inflightId: "req-1" }));
  const second = registry.register(sessionInput({ inflightId: "req-2" }));
  assert.notEqual(first.convId, second.convId);
  assert.equal(registry.size(), 2);
});

test("release deletes the upstream session once", () => {
  const { registry, calls } = captureRegistry();
  const entry = registry.register(sessionInput());
  registry.release("req-1");
  registry.release("req-1");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.method, "DELETE");
  assert.equal(
    calls[0]!.url,
    `http://127.0.0.1:8080/v1/stream?conv_id=${entry.convId}`,
  );
  assert.equal(registry.size(), 0);
});

test("release of an unknown id does nothing", () => {
  const { registry, calls } = captureRegistry();
  registry.release("missing");
  assert.equal(calls.length, 0);
});

test("beginPersist snapshots entries and suppresses upstream deletes", () => {
  const { registry, calls } = captureRegistry();
  registry.register(sessionInput({ inflightId: "req-1" }));
  registry.register(sessionInput({ inflightId: "req-2" }));
  const snapshot = registry.beginPersist();
  assert.equal(snapshot.length, 2);
  registry.release("req-1");
  registry.release("req-2");
  assert.equal(calls.length, 0);
});

test("resume key pins Claude Code attribution churn", () => {
  const body = (cch: string) => ({
    model: "m",
    messages: [
      {
        role: "system",
        content: `You are helpful.\nx-anthropic-billing-header: org=abc;cch=${cch}`,
      },
      { role: "user", content: "hi" },
    ],
  });
  const keyFor = (value: unknown) =>
    apiProxyStreamResumeKey({
      instanceId: "instance-a",
      path: "/v1/chat/completions",
      modelId: "model-a",
      body: value,
    });
  assert.equal(keyFor(body("0123abc")), keyFor(body("ffee99")));
  assert.notEqual(
    keyFor(body("0123abc")),
    keyFor({ ...body("0123abc"), messages: [] }),
  );
});

test("resume key ignores stream framing but not the route identity", () => {
  const base = { model: "m", messages: [{ role: "user", content: "hi" }] };
  const keyFor = (input: {
    instanceId?: string;
    path?: string;
    body?: unknown;
  }) =>
    apiProxyStreamResumeKey({
      instanceId: input.instanceId ?? "instance-a",
      path: input.path ?? "/v1/chat/completions",
      modelId: "model-a",
      body: input.body ?? base,
    });
  assert.equal(
    keyFor({ body: { ...base, stream: true, stream_options: { x: 1 } } }),
    keyFor({ body: base }),
  );
  assert.notEqual(keyFor({}), keyFor({ instanceId: "instance-b" }));
  assert.notEqual(keyFor({}), keyFor({ path: "/v1/completions" }));
});
