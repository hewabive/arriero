import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ApiProxyInflightRequestSchema,
  type ApiProxyInflightRequest,
} from "@arriero/core";

import {
  enrichDelegatedInflightView,
  mergeDelegatedInflight,
} from "./remote-inflight.js";

function view(over: Record<string, unknown> = {}): ApiProxyInflightRequest {
  return ApiProxyInflightRequestSchema.parse({
    id: "local-1",
    modelId: "qwen",
    protocol: "anthropic",
    stream: true,
    phase: "prefilling",
    waitingMs: 5,
    ...over,
  });
}

test("enrich pulls prefill progress and timings from the peer", () => {
  const merged = enrichDelegatedInflightView(
    view(),
    view({
      id: "peer-1",
      originId: "local-1",
      phase: "prefilling",
      waitingMs: 900,
      prefillMs: 4200,
      promptTokens: 32000,
      prefillTotalTokens: 32000,
      prefillProcessedTokens: 12000,
      prefillCachedTokens: 8000,
    }),
  );
  assert.equal(merged.id, "local-1");
  assert.equal(merged.waitingMs, 900);
  assert.equal(merged.prefillMs, 4200);
  assert.equal(merged.promptTokens, 32000);
  assert.equal(merged.prefillTotalTokens, 32000);
  assert.equal(merged.prefillProcessedTokens, 12000);
  assert.equal(merged.prefillCachedTokens, 8000);
});

test("enrich lets the peer report the lease queue before prefill", () => {
  const merged = enrichDelegatedInflightView(
    view({ phase: "prefilling" }),
    view({ id: "peer-1", originId: "local-1", phase: "queued" }),
  );
  assert.equal(merged.phase, "queued");
});

test("enrich keeps the local phase once stream evidence arrived", () => {
  const merged = enrichDelegatedInflightView(
    view({ phase: "generating", generatingMs: 1500, completionTokens: 40 }),
    view({
      id: "peer-1",
      originId: "local-1",
      phase: "prefilling",
      completionTokens: 20,
    }),
  );
  assert.equal(merged.phase, "generating");
  assert.equal(merged.generatingMs, 1500);
  assert.equal(merged.completionTokens, 40);
});

test("enrich never resurrects an ended request", () => {
  const done = enrichDelegatedInflightView(
    view({ phase: "done" }),
    view({ id: "peer-1", originId: "local-1", phase: "generating" }),
  );
  assert.equal(done.phase, "done");

  const stillLocal = enrichDelegatedInflightView(
    view({ phase: "generating" }),
    view({ id: "peer-1", originId: "local-1", phase: "done" }),
  );
  assert.equal(stillLocal.phase, "generating");
});

test("mergeDelegatedInflight enriches only correlated requests", () => {
  const local = new Map([
    ["target-a", [view(), view({ id: "local-2", phase: "thinking" })]],
  ]);
  const peers = new Map([
    [
      "local-1",
      view({
        id: "peer-1",
        originId: "local-1",
        prefillTotalTokens: 100,
        prefillProcessedTokens: 50,
      }),
    ],
  ]);
  const merged = mergeDelegatedInflight(local, peers);
  const requests = merged.get("target-a") ?? [];
  assert.equal(requests[0]?.prefillTotalTokens, 100);
  assert.equal(requests[1]?.prefillTotalTokens, null);
});

test("mergeDelegatedInflight returns the local map untouched without peers", () => {
  const local = new Map([["target-a", [view()]]]);
  assert.equal(mergeDelegatedInflight(local, new Map()), local);
});
