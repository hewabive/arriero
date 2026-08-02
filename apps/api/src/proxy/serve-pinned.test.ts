import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiProxyServeRequestSchema } from "@arriero/core";

import { instanceEndpointId } from "./endpoints.js";
import { ephemeralTarget } from "./serve-pinned.js";


function serveRequest(overrides: Record<string, unknown> = {}) {
  return ApiProxyServeRequestSchema.parse({
    instanceId: "qwen-big",
    protocol: "openai",
    endpoint: "chat.completions",
    stream: true,
    body: { model: "qwen", messages: [] },
    ...overrides,
  });
}

test("ephemeralTarget points at the local instance endpoint", () => {
  const target = ephemeralTarget(serveRequest());
  assert.equal(target.endpointId, instanceEndpointId("qwen-big"));
  assert.equal(target.id, "serve:qwen-big");
  assert.equal(target.name, "qwen-big");
});

test("ephemeralTarget carries the delegated QoS verbatim", () => {
  const target = ephemeralTarget(
    serveRequest({
      priority: 900,
      preemptible: false,
      model: "qwen2.5",
      role: "background",
      saveSlotsBeforeUnload: true,
      slotIds: [0, 1],
    }),
  );
  assert.equal(target.priority, 900);
  assert.equal(target.preemptible, false);
  assert.equal(target.model, "qwen2.5");
  assert.equal(target.role, "background");
  assert.equal(target.saveSlotsBeforeUnload, true);
  assert.deepEqual(target.slotIds, [0, 1]);
  assert.equal(target.idleUnloadMs, null);
});

test("ephemeralTarget defaults QoS to interactive preemptible", () => {
  const target = ephemeralTarget(serveRequest());
  assert.equal(target.priority, 100);
  assert.equal(target.preemptible, true);
  assert.equal(target.role, "interactive");
  assert.equal(target.model, null);
});
