import assert from "node:assert/strict";
import { test } from "node:test";

import { ApiProxyInflightRegistry, apiProxyInflight } from "./inflight.js";

function only(targetId: string) {
  const list = apiProxyInflight.snapshotByTarget().get(targetId) ?? [];
  assert.equal(list.length, 1);
  return list[0]!;
}

test("tracks phase transitions, prompt and completion tokens", () => {
  apiProxyInflight.reset();
  const handle = apiProxyInflight.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "t1",
    stream: true,
  });

  let view = only("t1");
  assert.equal(view.phase, "queued");
  assert.equal(view.prefillMs, null);
  assert.equal(view.generatingMs, null);
  assert.equal(view.completionTokens, 0);

  handle.dispatched();
  view = only("t1");
  assert.equal(view.phase, "prefilling");
  assert.notEqual(view.prefillMs, null);
  assert.equal(view.generatingMs, null);

  handle.firstToken(42);
  handle.setCompletionTokens(3);
  handle.setCompletionTokens(2);
  view = only("t1");
  assert.equal(view.phase, "generating");
  assert.equal(view.promptTokens, 42);
  assert.equal(view.completionTokens, 3);
  assert.notEqual(view.generatingMs, null);
  assert.equal(view.thinkingMs, null);

  handle.end();
  view = only("t1");
  assert.equal(view.phase, "done");
  assert.deepEqual(view.controls.forceAnswer, {
    available: false,
    reason: "request-finished",
  });
});

test("exposes the delegating origin id in views and the flat snapshot", () => {
  apiProxyInflight.reset();
  const handle = apiProxyInflight.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "serve:qwen",
    stream: true,
  });
  assert.equal(only("serve:qwen").originId, null);

  handle.setOrigin("entry-inflight-1");
  assert.equal(only("serve:qwen").originId, "entry-inflight-1");

  const list = apiProxyInflight.snapshotList();
  assert.equal(list.length, 1);
  assert.equal(list[0]?.originId, "entry-inflight-1");
  apiProxyInflight.reset();
});

test("splits prefill and thinking when reasoning precedes content", () => {
  let clock = 0;
  const registry = new ApiProxyInflightRegistry({ now: () => clock });
  const handle = registry.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "tk",
    stream: true,
  });
  const view = () => registry.snapshotByTarget().get("tk")![0]!;

  clock = 100;
  handle.dispatched();
  assert.equal(view().phase, "prefilling");

  clock = 400;
  handle.firstReasoning();
  let v = view();
  assert.equal(v.phase, "thinking");
  assert.equal(v.prefillMs, 300);

  clock = 900;
  v = view();
  assert.equal(v.prefillMs, 300);
  assert.equal(v.thinkingMs, 500);

  clock = 1000;
  handle.firstToken(7);
  v = view();
  assert.equal(v.phase, "generating");
  assert.equal(v.prefillMs, 300);
  assert.equal(v.thinkingMs, 600);
  assert.equal(v.promptTokens, 7);

  clock = 1500;
  v = view();
  assert.equal(v.thinkingMs, 600);
  assert.equal(v.generatingMs, 500);
  handle.end();
});

test("reasoning after generation began does not downgrade phase", () => {
  apiProxyInflight.reset();
  const handle = apiProxyInflight.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "tg",
  });
  handle.dispatched();
  handle.firstToken(5);
  handle.firstReasoning();
  const view = only("tg");
  assert.equal(view.phase, "generating");
  handle.end();
});

test("records live prefill progress and seeds prompt tokens from total", () => {
  apiProxyInflight.reset();
  const handle = apiProxyInflight.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "tp",
    stream: true,
  });
  handle.dispatched();
  handle.setPrefillProgress({ total: 200, cache: 20, processed: 80 });
  let view = only("tp");
  assert.equal(view.prefillTotalTokens, 200);
  assert.equal(view.prefillProcessedTokens, 80);
  assert.equal(view.prefillCachedTokens, 20);
  assert.equal(view.promptTokens, 200);

  handle.setPrefillProgress({ total: 200, cache: 20, processed: 200 });
  view = only("tp");
  assert.equal(view.prefillProcessedTokens, 200);
  handle.end();
});

test("excludes entries without a resolved target", () => {
  apiProxyInflight.reset();
  const handle = apiProxyInflight.begin({
    modelId: "m",
    protocol: "anthropic",
  });
  assert.equal(apiProxyInflight.snapshotByTarget().size, 0);
  handle.setTarget("t2");
  assert.equal(only("t2").modelId, "m");
  handle.end();
});

test("first prompt-token value wins and completion tokens are monotonic", () => {
  apiProxyInflight.reset();
  const handle = apiProxyInflight.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "t3",
  });
  handle.dispatched();
  handle.firstToken(10);
  handle.firstToken(20);
  handle.setCompletionTokens(5);
  handle.setCompletionTokens(4);
  const view = only("t3");
  assert.equal(view.promptTokens, 10);
  assert.equal(view.completionTokens, 5);
  handle.end();
});

test("captures reasoning/answer buffers and exposes them via getDetail", () => {
  apiProxyInflight.reset();
  const handle = apiProxyInflight.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "tr",
    stream: true,
  });
  handle.dispatched();
  handle.firstReasoning();
  handle.appendReasoning("Let me think");
  handle.appendReasoning(" carefully");

  const view = only("tr");
  assert.equal(view.reasoningChars, "Let me think carefully".length);

  const detail = apiProxyInflight.getDetail(handle.id);
  assert.ok(detail);
  assert.equal(detail.reasoningText, "Let me think carefully");
  assert.equal(detail.reasoningChars, "Let me think carefully".length);
  assert.equal(detail.reasoningTruncated, false);
  assert.equal(detail.answerText, "");

  handle.firstToken(3);
  handle.appendAnswer("Hi");
  const after = apiProxyInflight.getDetail(handle.id);
  assert.ok(after);
  assert.equal(after.answerText, "Hi");
  assert.equal(after.phase, "generating");

  handle.end();
  const ended = apiProxyInflight.getDetail(handle.id);
  assert.ok(ended);
  assert.equal(ended.phase, "done");
  assert.equal(ended.answerText, "Hi");
});

test("caps the reasoning buffer and flags truncation", () => {
  apiProxyInflight.reset();
  const handle = apiProxyInflight.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "tc",
    stream: true,
  });
  handle.appendReasoning("a".repeat(300_000));
  const detail = apiProxyInflight.getDetail(handle.id);
  assert.ok(detail);
  assert.equal(detail.reasoningChars, 300_000);
  assert.equal(detail.reasoningTruncated, true);
  assert.equal(detail.reasoningText.length, 256 * 1024);
  handle.end();
});

test("force-answer control is gated by support and the thinking phase", async () => {
  apiProxyInflight.reset();
  assert.equal(
    (await apiProxyInflight.requestControl("nope", "force-answer")).status,
    "not-found",
  );

  const handle = apiProxyInflight.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "ti",
    stream: true,
  });
  handle.dispatched();
  assert.equal(only("ti").controls.forceAnswer.reason, "not-supported");
  assert.equal(
    (await apiProxyInflight.requestControl(handle.id, "force-answer")).status,
    "not-supported",
  );

  const signal = handle.controlSignal("force-answer");
  assert.equal(
    (await apiProxyInflight.requestControl(handle.id, "force-answer")).status,
    "not-ready",
  );
  assert.equal(only("ti").controls.forceAnswer.available, false);

  handle.firstReasoning();
  handle.appendReasoning("R");
  assert.equal(only("ti").controls.forceAnswer.available, true);

  assert.equal(signal.aborted, false);
  assert.equal(
    (await apiProxyInflight.requestControl(handle.id, "force-answer")).status,
    "ok",
  );
  assert.equal(signal.aborted, true);

  const rearmed = handle.controlSignal("force-answer");
  assert.equal(rearmed.aborted, false);

  handle.firstToken(5);
  assert.equal(only("ti").controls.forceAnswer.available, false);
  assert.equal(
    (await apiProxyInflight.requestControl(handle.id, "force-answer")).status,
    "too-late",
  );
  handle.end();
});

test("control handlers expose dynamic readiness and failures", async () => {
  apiProxyInflight.reset();
  const handle = apiProxyInflight.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "th",
    stream: true,
  });
  let ready = false;
  handle.setControl("force-answer", {
    unavailableReason: () => (ready ? null : "not-ready"),
    execute: () => ({ status: "failed", message: "upstream rejected" }),
  });
  handle.firstReasoning();
  assert.equal(only("th").controls.forceAnswer.reason, "not-ready");
  ready = true;
  assert.equal(only("th").controls.forceAnswer.available, true);
  assert.deepEqual(
    await apiProxyInflight.requestControl(handle.id, "force-answer"),
    { status: "failed", message: "upstream rejected" },
  );
  handle.end();
});

test("tracks tool calls and switches to the tool phase", () => {
  apiProxyInflight.reset();
  const handle = apiProxyInflight.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "tt",
    stream: true,
  });
  handle.firstToken(10);
  assert.equal(only("tt").phase, "generating");

  handle.appendToolCall({ index: 0, id: "call_1", name: "get_weather" });
  handle.appendToolCall({ index: 0, arguments: '{"city":' });
  handle.appendToolCall({ index: 0, arguments: '"Paris"}' });
  handle.appendToolCall({ index: 1, name: "get_time", arguments: "{}" });

  const view = only("tt");
  assert.equal(view.phase, "tool");
  assert.equal(view.toolCalls, 2);

  const detail = apiProxyInflight.getDetail(handle.id);
  assert.ok(detail);
  assert.equal(detail.phase, "tool");
  assert.deepEqual(detail.toolCalls, [
    { name: "get_weather", arguments: '{"city":"Paris"}' },
    { name: "get_time", arguments: "{}" },
  ]);
  handle.end();
});

test("finish and cancel abort their signals in any phase", async () => {
  apiProxyInflight.reset();
  assert.equal(
    (await apiProxyInflight.requestControl("nope", "finish")).status,
    "not-found",
  );
  assert.equal(
    (await apiProxyInflight.requestControl("nope", "cancel")).status,
    "not-found",
  );

  const handle = apiProxyInflight.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "ti",
    stream: true,
  });
  const finishSignal = handle.controlSignal("finish");
  const cancelSignal = handle.controlSignal("cancel");
  assert.equal(finishSignal.aborted, false);
  assert.equal(cancelSignal.aborted, false);

  assert.equal(
    (await apiProxyInflight.requestControl(handle.id, "finish")).status,
    "ok",
  );
  assert.equal(finishSignal.aborted, true);
  assert.equal(cancelSignal.aborted, false);

  assert.equal(
    (await apiProxyInflight.requestControl(handle.id, "cancel")).status,
    "ok",
  );
  assert.equal(cancelSignal.aborted, true);

  handle.end();
  assert.equal(
    (await apiProxyInflight.requestControl(handle.id, "finish")).status,
    "not-found",
  );
  assert.equal(
    (await apiProxyInflight.requestControl(handle.id, "cancel")).status,
    "not-found",
  );
});

test("retains ended requests with frozen timings, then sweeps them", async () => {
  let clock = 0;
  const registry = new ApiProxyInflightRegistry({
    now: () => clock,
    endedRetainMs: 1000,
  });
  const handle = registry.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "te",
    stream: true,
  });
  clock = 100;
  handle.dispatched();
  clock = 200;
  handle.firstToken(5);
  handle.appendAnswer("Hi");
  clock = 600;
  handle.end();

  clock = 900;
  const view = registry.snapshotByTarget().get("te")?.[0];
  assert.ok(view);
  assert.equal(view.phase, "done");
  assert.equal(view.generatingMs, 400);
  const detail = registry.getDetail(handle.id);
  assert.ok(detail);
  assert.equal(detail.answerText, "Hi");
  assert.equal(
    (await registry.requestControl(handle.id, "finish")).status,
    "not-found",
  );
  assert.equal(
    (await registry.requestControl(handle.id, "cancel")).status,
    "not-found",
  );
  assert.equal(
    (await registry.requestControl(handle.id, "force-answer")).status,
    "not-found",
  );

  clock = 1700;
  assert.equal(registry.snapshotByTarget().get("te"), undefined);
  assert.equal(registry.getDetail(handle.id), null);
});

test("end(false) marks the entry failed and blocks further actions", async () => {
  apiProxyInflight.reset();
  const handle = apiProxyInflight.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "tf",
    stream: true,
  });
  handle.dispatched();
  handle.end(false);
  const view = only("tf");
  assert.equal(view.phase, "failed");
  assert.equal(
    (await apiProxyInflight.requestControl(handle.id, "finish")).status,
    "not-found",
  );
  assert.equal(
    (await apiProxyInflight.requestControl(handle.id, "cancel")).status,
    "not-found",
  );

  handle.end();
  assert.equal(only("tf").phase, "failed");
});

test("sweeps inflight entries with no progress past the stale threshold", () => {
  let clock = 0;
  const registry = new ApiProxyInflightRegistry({
    now: () => clock,
    staleAfterMs: 1000,
  });
  registry.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "stuck",
    stream: true,
  });

  clock = 900;
  assert.equal(registry.snapshotByTarget().get("stuck")?.length, 1);

  clock = 1500;
  assert.equal(registry.snapshotByTarget().get("stuck"), undefined);
});

test("keeps inflight entries that show recent progress", () => {
  let clock = 0;
  const registry = new ApiProxyInflightRegistry({
    now: () => clock,
    staleAfterMs: 1000,
  });
  const handle = registry.begin({
    modelId: "m",
    protocol: "openai",
    targetId: "live",
    stream: true,
  });
  handle.dispatched();

  clock = 1500;
  handle.setCompletionTokens(1);
  clock = 2000;
  assert.equal(registry.snapshotByTarget().get("live")?.length, 1);

  clock = 3500;
  assert.equal(registry.snapshotByTarget().get("live"), undefined);
});
